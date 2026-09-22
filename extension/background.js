// Thin relay: connects out to the local MCP server and forwards CDP commands
// to any tab. All agent logic lives in the server. The one thing buffered here
// is console/network events, which have to be collected as they happen.
const URL_ = "ws://127.0.0.1:17333";
let ws = null;
let pingTimer = null;
const attached = new Set();

// Whatever goes wrong in here otherwise only shows on chrome://extensions,
// where neither an agent nor a test can look. Keep a copy the bridge can read.
const errors = [];
const logError = (e) => errors.push({ ts: Date.now(), message: String(e?.message ?? e) }) > 50 && errors.shift();
self.addEventListener("error", (e) => logError(e.error ?? e.message));
self.addEventListener("unhandledrejection", (e) => logError(e.reason));
// Chrome prints "WebSocket is already in CLOSING or CLOSED state" exactly when
// send() is called on a socket that is not open. It is not an exception, so
// nothing above would see it. Record it here, where a test can.
const nativeSend = WebSocket.prototype.send;
WebSocket.prototype.send = function (data) {
  if (this.readyState !== 1) logError(`send() on a WebSocket in readyState ${this.readyState}: ${String(data).slice(0, 80)}`);
  return nativeSend.call(this, data);
};
let droppedReplies = 0; // replies withheld because the connection that asked was gone
let isActive = null; // whether the server uses this profile; null until a server says

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
    case "tabs.activate": {
      // Chrome stops drawing hidden tabs, and mouse input waits on drawing: a
      // click takes 5s and a wheel scroll never returns. Switching the visible
      // tab of that window fixes it without taking OS focus from the person.
      const t = await chrome.tabs.get(msg.tabId);
      if (t.active) return { switched: false };
      await chrome.tabs.update(msg.tabId, { active: true });
      return { switched: true };
    }
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
    case "diagnostics": {
      const out = { version: chrome.runtime.getManifest().version, errors: [...errors], droppedReplies };
      if (msg.clear) errors.length = 0;
      return out;
    }
    case "reload":
      // Re-reads the unpacked extension from disk. Answer first, then reload.
      setTimeout(() => chrome.runtime.reload(), 100);
      return { reloading: true };
    default:
      throw new Error("unknown message type " + msg.type);
  }
}

// Chrome logs every refused connection on the extension's Errors page and code
// can't silence that, so back off while no server is running: 2s, 4s, 8s, then
// every 10s. Not slower than that: a new agent session should find the browser
// within seconds. The first retry stays fast because a peer server may be taking
// over the port.
let retryMs = 2000;

function connect() {
  if (ws && ws.readyState <= 1) return;
  const sock = (ws = new WebSocket(URL_));
  sock.onopen = () => {
    retryMs = 2000;
    // WebSocket traffic resets the service worker idle timer, so ping under 30s.
    pingTimer = setInterval(() => sock.readyState === 1 && sock.send('{"type":"ping"}'), 20000);
  };
  sock.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "active") return void (isActive = msg.value); // an announcement, not a request
    let reply;
    try {
      reply = { id: msg.id, result: await handle(msg) };
    } catch (err) {
      reply = { id: msg.id, error: String(err?.message ?? err) };
    }
    // Answer on the connection that asked, and only if it is still there. A
    // command can outlive its connection (a tab close stuck behind a dialog),
    // and its reply must not land on a newer connection with reused ids.
    if (sock.readyState === 1) sock.send(JSON.stringify(reply));
    else droppedReplies++;
  };
  sock.onclose = () => {
    clearInterval(pingTimer);
    if (ws === sock) (ws = null), (isActive = null);
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 10000);
  };
  sock.onerror = () => {};
}

// The server may start after Chrome, so keep retrying.
chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
// The toolbar popup (popup.html) asks for status and can make this profile the
// one the server uses, for when the extension is loaded in several profiles.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === "activate") {
    connect();
    if (ws?.readyState === 1) ws.send('{"type":"activate"}');
  }
  respond({ connected: ws?.readyState === 1, isActive, version: chrome.runtime.getManifest().version });
});
connect();
