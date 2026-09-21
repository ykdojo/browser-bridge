// Thin relay: connects out to the local MCP server and forwards CDP commands
// to any tab. All agent logic lives in the server. The one thing buffered here
// is console/network events, which have to be collected as they happen.
const URL_ = "ws://127.0.0.1:17333";
let ws = null;
let pingTimer = null;
const attached = new Set();

// ---- event buffers --------------------------------------------------------
// Capture begins when a tab is first attached. Buffers are capped, and network
// entries reset when the tab moves to a different site (console persists,
// matching what DevTools shows with "preserve log" off... roughly).
const consoleBuf = new Map(); // tabId -> [{ts, level, text}]
const netBuf = new Map(); // tabId -> Map(requestId -> entry), insertion-ordered
const lastHost = new Map();
const MAX_CONSOLE = 500;
const MAX_NET = 1000;

const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  const h = hostOf(info.url);
  if (lastHost.has(tabId) && lastHost.get(tabId) !== h) {
    netBuf.delete(tabId);
    consoleBuf.delete(tabId);
  }
  lastHost.set(tabId, h);
});

// ---- dialogs and notices --------------------------------------------------
// A JavaScript dialog (alert/confirm/prompt/"Leave site?") freezes the page, and
// with it every command the agent sends. So dialogs the agent causes are
// answered right away and reported back as a notice on the next result. A dialog
// that opens while only a person is using the tab is left alone for them.
const notices = new Map(); // tabId -> [{kind, ...}], delivered with the next cdp result
const dialogOpen = new Map(); // tabId -> {type, message}
const lastCmd = new Map(); // tabId -> time of the agent's latest command
const inflight = new Map(); // tabId -> commands currently running
const leaveUntil = new Map(); // tabId -> until when "Leave site?" prompts are accepted
const AGENT_ACTIVE_MS = 3000;

function notice(tabId, n) {
  const list = notices.get(tabId) ?? [];
  list.push(n);
  notices.set(tabId, list.slice(-20));
}

function answerDialog(tabId, d, late) {
  // alert has one button. Everything else is cancelled unless leaving was asked for.
  const accepted = d.type === "alert" || (d.type === "beforeunload" && (leaveUntil.get(tabId) ?? 0) > Date.now());
  dialogOpen.delete(tabId);
  notice(tabId, { kind: "dialog", dialogType: d.type, message: (d.message ?? "").slice(0, 300), accepted, late });
  return chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: accepted }).catch(() => {});
}

function dropTab(tabId) {
  attached.delete(tabId);
  consoleBuf.delete(tabId);
  netBuf.delete(tabId);
  lastHost.delete(tabId);
  for (const m of [notices, dialogOpen, lastCmd, inflight, leaveUntil]) m.delete(tabId);
}
chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));
chrome.tabs.onRemoved.addListener(dropTab);

function pushConsole(tabId, entry) {
  let buf = consoleBuf.get(tabId);
  if (!buf) consoleBuf.set(tabId, (buf = []));
  buf.push(entry);
  if (buf.length > MAX_CONSOLE) buf.splice(0, buf.length - MAX_CONSOLE);
}

const fmtArg = (a) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description ?? a.type);

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (tabId == null) return;
  switch (method) {
    case "Runtime.consoleAPICalled":
      pushConsole(tabId, { ts: params.timestamp, level: params.type === "warning" ? "warn" : params.type, text: params.args.map(fmtArg).join(" ").slice(0, 2000) });
      break;
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails;
      pushConsole(tabId, { ts: params.timestamp, level: "error", text: (d.exception?.description ?? d.text).slice(0, 2000) });
      break;
    }
    case "Network.requestWillBeSent": {
      let buf = netBuf.get(tabId);
      if (!buf) netBuf.set(tabId, (buf = new Map()));
      buf.set(params.requestId, { url: params.request.url, method: params.request.method, resourceType: params.type, ts: params.wallTime });
      if (buf.size > MAX_NET) buf.delete(buf.keys().next().value);
      break;
    }
    case "Network.responseReceived": {
      const e = netBuf.get(tabId)?.get(params.requestId);
      if (e) { e.status = params.response.status; e.mimeType = params.response.mimeType; }
      break;
    }
    case "Network.loadingFailed": {
      const e = netBuf.get(tabId)?.get(params.requestId);
      if (e) e.failed = params.errorText;
      break;
    }
    case "Page.javascriptDialogOpening": {
      const d = { type: params.type, message: params.message };
      dialogOpen.set(tabId, d);
      const agentActive = (inflight.get(tabId) ?? 0) > 0 || Date.now() - (lastCmd.get(tabId) ?? 0) < AGENT_ACTIVE_MS;
      if (agentActive) answerDialog(tabId, d, false);
      break;
    }
    case "Page.javascriptDialogClosed":
      dialogOpen.delete(tabId);
      break;
    case "Page.fileChooserOpened":
      notice(tabId, { kind: "filechooser" });
      break;
  }
});

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return false;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    // The service worker restarted and forgot a session that Chrome kept.
    if (!/already attached/i.test(String(e?.message ?? e))) throw e;
  }
  attached.add(tabId);
  // Start event capture right away so console/network reads have data later.
  // Page events carry the dialog and file-picker reports.
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await chrome.debugger.sendCommand({ tabId }, "Network.enable").catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
  return true;
}

async function handle(msg) {
  switch (msg.type) {
    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active }));
    }
    case "tabs.create": {
      const t = await chrome.tabs.create({ url: msg.url, active: msg.active ?? true });
      return { tabId: t.id };
    }
    case "tabs.close":
      // Closing is leaving: accept the page's "Leave site?" prompt if it has one.
      leaveUntil.set(msg.tabId, Date.now() + 10000);
      lastCmd.set(msg.tabId, Date.now());
      await chrome.tabs.remove(msg.tabId);
      return { closed: true };
    case "dialogs.policy":
      if (msg.acceptBeforeunload) leaveUntil.set(msg.tabId, Date.now() + 10000);
      return { ok: true };
    case "console.read": {
      const justAttached = await ensureAttached(msg.tabId);
      const entries = consoleBuf.get(msg.tabId) ?? [];
      if (msg.clear) consoleBuf.delete(msg.tabId);
      return { entries, justAttached };
    }
    case "network.read": {
      const justAttached = await ensureAttached(msg.tabId);
      const entries = [...(netBuf.get(msg.tabId)?.values() ?? [])];
      if (msg.clear) netBuf.delete(msg.tabId);
      return { entries, justAttached };
    }
    case "cdp": {
      const tabId = msg.tabId;
      await ensureAttached(tabId);
      // A dialog from before the agent got here would hang this command.
      if (dialogOpen.has(tabId)) await answerDialog(tabId, dialogOpen.get(tabId), true);
      lastCmd.set(tabId, Date.now());
      inflight.set(tabId, (inflight.get(tabId) ?? 0) + 1);
      let result;
      try {
        result = (await chrome.debugger.sendCommand({ tabId }, msg.method, msg.params ?? {})) ?? {};
      } finally {
        inflight.set(tabId, inflight.get(tabId) - 1);
        lastCmd.set(tabId, Date.now());
      }
      if (notices.get(tabId)?.length) {
        result.__bridgeNotices = notices.get(tabId);
        notices.delete(tabId);
      }
      return result;
    }
    case "version":
      return { version: chrome.runtime.getManifest().version };
    case "reload":
      // Re-reads the unpacked extension from disk. Answer first, then reload.
      setTimeout(() => chrome.runtime.reload(), 100);
      return { reloading: true };
    default:
      throw new Error("unknown message type " + msg.type);
  }
}

function connect() {
  if (ws && ws.readyState <= 1) return;
  ws = new WebSocket(URL_);
  ws.onopen = () => {
    // WebSocket traffic resets the service worker idle timer, so ping under 30s.
    pingTimer = setInterval(() => ws?.readyState === 1 && ws.send('{"type":"ping"}'), 20000);
  };
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    try {
      ws.send(JSON.stringify({ id: msg.id, result: await handle(msg) }));
    } catch (err) {
      ws.send(JSON.stringify({ id: msg.id, error: String(err?.message ?? err) }));
    }
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    ws = null;
    setTimeout(connect, 2000); // a peer server may be taking over the port
  };
  ws.onerror = () => {};
}

// The server may start after Chrome, so keep retrying.
chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
// With the extension loaded in several Chrome profiles, the server talks to one
// at a time. Clicking the icon makes this profile the active one.
chrome.action.onClicked.addListener(() => {
  connect();
  if (ws?.readyState === 1) ws.send('{"type":"activate"}');
});
connect();
