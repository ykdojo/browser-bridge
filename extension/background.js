// Browser Bridge extension. A thin relay: it connects out to the local MCP
// server and runs the commands the server sends, mostly Chrome DevTools
// Protocol (CDP) calls against a tab via chrome.debugger. All agent logic
// lives in the server. What has to live here is whatever must happen inside
// the browser as events occur: buffering console/network events, answering
// JavaScript dialogs, and reporting on this extension itself.
//
// Sections: per-tab state, self-reporting, commands, the server link.

const SERVER = "127.0.0.1:17333";
const RETRY_MS = 2000;
const VERSION = chrome.runtime.getManifest().version;

// ---- per-tab state ---------------------------------------------------------
// Everything the extension remembers about a tab, created on first use and
// dropped when the tab closes. Capture starts when the debugger attaches.
const tabs = new Map();
const CONSOLE_MAX = 500;
const NETWORK_MAX = 1000;

function tab(tabId) {
  let t = tabs.get(tabId);
  if (!t) {
    tabs.set(tabId, (t = {
      attached: false,
      console: [], // {ts, level, text}
      network: new Map(), // requestId -> {url, method, resourceType, ts, status?, mimeType?, failed?}, insertion-ordered
      host: null, // buffers reset when the tab moves to a different site
      notices: [], // things the agent could not otherwise see, delivered with the next command result
      dialog: null, // {type, message} while a JavaScript dialog is open
      busyUntil: 0, // the agent counts as active on this tab until this time
      leaveUntil: 0, // "Leave site?" prompts are accepted until this time
    }));
  }
  return t;
}

chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
chrome.debugger.onDetach.addListener(({ tabId }) => { if (tabs.has(tabId)) tab(tabId).attached = false; });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url || !tabs.has(tabId)) return;
  const t = tab(tabId);
  let host = "";
  try { host = new URL(info.url).host; } catch {}
  if (t.host !== null && t.host !== host) { t.console = []; t.network = new Map(); }
  t.host = host;
});

async function attach(tabId) {
  const t = tab(tabId);
  if (t.attached) return false;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    // The service worker restarted and forgot a session that Chrome kept.
    if (!/already attached/i.test(String(e?.message ?? e))) throw e;
  }
  t.attached = true;
  const cdp = (method) => chrome.debugger.sendCommand({ tabId }, method).catch(() => {});
  await Promise.all([cdp("Runtime.enable"), cdp("Network.enable"), cdp("Page.enable")]);
  return true;
}

// A JavaScript dialog (alert/confirm/prompt/"Leave site?") freezes the page and
// every command behind it. Dialogs the agent caused are answered at once and
// reported; a dialog that opens while only a person is using the tab is theirs.
const agentActive = (t) => Date.now() < t.busyUntil;

function answerDialog(tabId, t) {
  const d = t.dialog;
  t.dialog = null;
  const accepted = d.type === "alert" || (d.type === "beforeunload" && Date.now() < t.leaveUntil);
  t.notices.push({ kind: "dialog", dialogType: d.type, message: (d.message ?? "").slice(0, 300), accepted });
  return chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: accepted }).catch(() => {});
}

const describe = (a) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description ?? a.type);

chrome.debugger.onEvent.addListener(({ tabId, targetId }, method, params) => {
  if (targetId && targetId === self_.target) return onOwnConsoleEvent(method, params);
  if (tabId == null || !tabs.has(tabId)) return;
  const t = tab(tabId);
  switch (method) {
    case "Runtime.consoleAPICalled":
      t.console.push({ ts: params.timestamp, level: params.type === "warning" ? "warn" : params.type, text: params.args.map(describe).join(" ").slice(0, 2000) });
      if (t.console.length > CONSOLE_MAX) t.console.splice(0, t.console.length - CONSOLE_MAX);
      break;
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails;
      t.console.push({ ts: params.timestamp, level: "error", text: (d.exception?.description ?? d.text).slice(0, 2000) });
      break;
    }
    case "Network.requestWillBeSent":
      t.network.set(params.requestId, { url: params.request.url, method: params.request.method, resourceType: params.type, ts: params.wallTime });
      if (t.network.size > NETWORK_MAX) t.network.delete(t.network.keys().next().value);
      break;
    case "Network.responseReceived":
      Object.assign(t.network.get(params.requestId) ?? {}, { status: params.response.status, mimeType: params.response.mimeType });
      break;
    case "Network.loadingFailed":
      Object.assign(t.network.get(params.requestId) ?? {}, { failed: params.errorText });
      break;
    case "Page.javascriptDialogOpening":
      t.dialog = { type: params.type, message: params.message };
      if (agentActive(t)) answerDialog(tabId, t);
      break;
    case "Page.javascriptDialogClosed":
      t.dialog = null;
      break;
    case "Page.fileChooserOpened":
      t.notices.push({ kind: "filechooser" });
      break;
  }
});

// ---- self-reporting --------------------------------------------------------
// This extension's own failures show only on chrome://extensions, where
// nothing automated can look. So it keeps what a person would see there:
// uncaught errors, and (on request) what Chrome prints into its console, by
// attaching the debugger to its own service worker. Read via "diagnostics".
const self_ = { errors: [], console: [], target: null, droppedReplies: 0, isActive: null };
const logError = (e) => self_.errors.push({ ts: Date.now(), message: String(e?.message ?? e) }) > 50 && self_.errors.shift();
self.addEventListener("error", (e) => logError(e.error ?? e.message));
self.addEventListener("unhandledrejection", (e) => logError(e.reason));
// Chrome prints "WebSocket is already in CLOSING or CLOSED state" for a send()
// on a socket that is not open. It is not an exception, so catch it here.
const nativeSend = WebSocket.prototype.send;
WebSocket.prototype.send = function (data) {
  if (this.readyState !== 1) logError(`send() on a WebSocket in readyState ${this.readyState}: ${String(data).slice(0, 80)}`);
  return nativeSend.call(this, data);
};

function onOwnConsoleEvent(method, params) {
  if (method === "Log.entryAdded" && params.entry.level === "error") self_.console.push({ source: params.entry.source, text: params.entry.text.slice(0, 300) });
  if (method === "Runtime.exceptionThrown") self_.console.push({ source: "exception", text: String(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text).slice(0, 300) });
}

async function watchOwnConsole(on) {
  if (!on) {
    if (self_.target) await chrome.debugger.detach({ targetId: self_.target }).catch(() => {});
    self_.target = null;
    return { watching: false };
  }
  if (self_.target) return { watching: true };
  const me = (await chrome.debugger.getTargets()).find((x) => x.url === chrome.runtime.getURL("background.js"));
  if (!me) throw new Error("own service worker not found among debugger targets");
  await chrome.debugger.attach({ targetId: me.id }, "1.3");
  self_.target = me.id;
  await chrome.debugger.sendCommand({ targetId: me.id }, "Log.enable");
  await chrome.debugger.sendCommand({ targetId: me.id }, "Runtime.enable");
  return { watching: true };
}

// ---- commands --------------------------------------------------------------
const commands = {
  // tabs and windows
  "tabs.list": async () => (await chrome.tabs.query({})).map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active })),
  "tabs.create": async ({ url, active = true, windowId, nearTabId }) => {
    // Open next to the tab the agent last worked in, so an agent given its own
    // window stays there instead of landing in whichever window has focus.
    if (windowId == null && nearTabId != null) windowId = await chrome.tabs.get(nearTabId).then((t) => t.windowId, () => undefined);
    return { tabId: (await chrome.tabs.create({ url, active, windowId })).id };
  },
  "tabs.close": async ({ tabId }) => {
    // Closing is leaving: accept the page's "Leave site?" prompt if it has one.
    const t = tab(tabId);
    t.leaveUntil = t.busyUntil = Date.now() + 10000;
    await chrome.tabs.remove(tabId);
    return { closed: true };
  },
  "tabs.activate": async ({ tabId }) => {
    // Chrome stops drawing hidden tabs, and mouse input waits on drawing: a
    // click takes 5s and a wheel scroll never returns. Switching the visible
    // tab of its window fixes that without taking OS focus from the person.
    if ((await chrome.tabs.get(tabId)).active) return { switched: false };
    await chrome.tabs.update(tabId, { active: true });
    return { switched: true };
  },
  "windows.create": async ({ url = "about:blank" } = {}) => {
    // A window of the agent's own, so its tabs never sit in one a person is using.
    const w = await chrome.windows.create({ url, focused: false, width: 1280, height: 900 });
    return { windowId: w.id, tabId: w.tabs[0].id };
  },
  "windows.close": async ({ windowId }) => (await chrome.windows.remove(windowId), { closed: true }),

  // the tab's page
  cdp: async ({ tabId, method, params = {} }) => {
    await attach(tabId);
    const t = tab(tabId);
    if (t.dialog) await answerDialog(tabId, t); // a dialog from before would hang this command
    t.busyUntil = Infinity;
    let result;
    try {
      result = (await chrome.debugger.sendCommand({ tabId }, method, params)) ?? {};
    } finally {
      t.busyUntil = Date.now() + 3000; // a dialog the command set in motion may open just after it returns
    }
    if (t.notices.length) result.__bridgeNotices = t.notices.splice(0);
    return result;
  },
  "dialogs.policy": ({ tabId, acceptBeforeunload }) => {
    if (acceptBeforeunload) tab(tabId).leaveUntil = Date.now() + 10000;
    return { ok: true };
  },
  "console.read": async ({ tabId, clear }) => {
    const justAttached = await attach(tabId);
    const t = tab(tabId);
    const entries = t.console;
    if (clear) t.console = [];
    return { entries, justAttached };
  },
  "network.read": async ({ tabId, clear }) => {
    const justAttached = await attach(tabId);
    const t = tab(tabId);
    const entries = [...t.network.values()];
    if (clear) t.network = new Map();
    return { entries, justAttached };
  },

  // the extension itself
  version: () => ({ version: VERSION }),
  diagnostics: ({ clear }) => {
    const out = { version: VERSION, errors: [...self_.errors], console: [...self_.console], droppedReplies: self_.droppedReplies };
    if (clear) self_.errors.length = self_.console.length = 0;
    return out;
  },
  "console.watch": ({ on = true }) => watchOwnConsole(on),
  // Test hook for what the server link relies on: a refused fetch must not
  // make Chrome print an error. If a Chrome release changes that, the e2e
  // suite notices before a user's chrome://extensions page does.
  probe: ({ port }) => fetch(`http://127.0.0.1:${port}/`, { cache: "no-store" }).then((r) => "resolved " + r.status, (e) => "rejected: " + e.message),
  reload: () => {
    // Re-reads the unpacked extension from disk. Answer first, then reload.
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloading: true };
  },
};

// ---- the server link -------------------------------------------------------
// Chrome prints an error on chrome://extensions for every refused WebSocket,
// and code can't catch or silence it. A refused fetch prints nothing
// (measured, see TESTING.md). So knock with fetch, and open the WebSocket
// only once a Browser Bridge server answers. With no agent session running,
// that page stays clean, and the knock is cheap enough to repeat every 2s.
let ws = null;
let connecting = false;

async function serverIsUp() {
  try {
    const r = await fetch(`http://${SERVER}/`, { cache: "no-store" });
    return r.status === 426 || (r.ok && (await r.json()).name === "browser-bridge");
  } catch {
    return false;
  }
}

async function connect() {
  if (connecting || ws?.readyState <= 1) return;
  connecting = true;
  const up = await serverIsUp();
  connecting = false;
  if (!up) return void setTimeout(connect, RETRY_MS);
  if (ws?.readyState <= 1) return;
  const sock = (ws = new WebSocket(`ws://${SERVER}`));
  // WebSocket traffic resets the service worker idle timer, so ping under 30s.
  const ping = setInterval(() => sock.readyState === 1 && sock.send('{"type":"ping"}'), 20000);
  sock.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "active") return void (self_.isActive = msg.value); // an announcement, not a request
    let reply;
    try {
      const run = commands[msg.type];
      if (!run) throw new Error("unknown message type " + msg.type);
      reply = { id: msg.id, result: await run(msg) };
    } catch (err) {
      reply = { id: msg.id, error: String(err?.message ?? err) };
    }
    // Answer on the connection that asked, and only if it is still there. A
    // command can outlive its connection, and its reply must not land on a
    // newer connection with reused ids.
    if (sock.readyState === 1) sock.send(JSON.stringify(reply));
    else self_.droppedReplies++;
  };
  sock.onclose = () => {
    clearInterval(ping);
    if (ws === sock) (ws = null), (self_.isActive = null);
    setTimeout(connect, RETRY_MS);
  };
  sock.onerror = () => {};
}

// The server may start after Chrome, so keep looking.
chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
// The toolbar popup asks for status, and can make this profile the one the
// server uses when the extension is loaded in several profiles.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === "activate" && ws?.readyState === 1) ws.send('{"type":"activate"}');
  respond({ connected: ws?.readyState === 1, isActive: self_.isActive, version: VERSION });
});
connect();
