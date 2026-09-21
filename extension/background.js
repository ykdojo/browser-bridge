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

function dropTab(tabId) {
  attached.delete(tabId);
  consoleBuf.delete(tabId);
  netBuf.delete(tabId);
  lastHost.delete(tabId);
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
  }
});

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return false;
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
  // Start event capture right away so console/network reads have data later.
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await chrome.debugger.sendCommand({ tabId }, "Network.enable").catch(() => {});
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
      await chrome.tabs.remove(msg.tabId);
      return { closed: true };
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
      await ensureAttached(msg.tabId);
      return (await chrome.debugger.sendCommand({ tabId: msg.tabId }, msg.method, msg.params ?? {})) ?? {};
    }
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
chrome.action.onClicked.addListener(connect);
connect();
