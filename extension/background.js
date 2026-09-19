// Thin relay: connects out to the local MCP server and forwards CDP commands
// to tabs the user has shared. All agent logic lives in the server.
const URL = "ws://127.0.0.1:17333";
let ws = null;
let pingTimer = null;
const attached = new Set();

// Shared tab ids live in session storage so they survive service worker restarts.
const getShared = async () => new Set((await chrome.storage.session.get("shared")).shared ?? []);
const setShared = (s) => chrome.storage.session.set({ shared: [...s] });

async function refreshBadge(tabId) {
  const on = (await getShared()).has(tabId);
  chrome.action.setBadgeText({ tabId, text: on ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#2a78d6" });
}

async function share(tabId, on) {
  const s = await getShared();
  on ? s.add(tabId) : s.delete(tabId);
  await setShared(s);
  if (!on && attached.has(tabId)) chrome.debugger.detach({ tabId }).catch(() => {});
  refreshBadge(tabId);
}

chrome.action.onClicked.addListener(async (tab) => {
  await share(tab.id, !(await getShared()).has(tab.id));
  connect();
});
chrome.tabs.onUpdated.addListener((tabId, info) => info.status && refreshBadge(tabId));
chrome.tabs.onRemoved.addListener((tabId) => share(tabId, false));
chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));

async function handle(msg) {
  const shared = await getShared();
  const need = (tabId) => {
    if (!shared.has(tabId)) throw new Error(`Tab ${tabId} is not shared. Ask the user to click the Chrome Bridge icon on it.`);
  };
  switch (msg.type) {
    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return tabs.filter((t) => shared.has(t.id)).map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active }));
    }
    case "tabs.create": {
      const t = await chrome.tabs.create({ url: msg.url, active: msg.active ?? true });
      await share(t.id, true);
      return { tabId: t.id };
    }
    case "tabs.close":
      need(msg.tabId);
      await chrome.tabs.remove(msg.tabId);
      return { closed: true };
    case "cdp": {
      need(msg.tabId);
      if (!attached.has(msg.tabId)) {
        await chrome.debugger.attach({ tabId: msg.tabId }, "1.3");
        attached.add(msg.tabId);
      }
      return (await chrome.debugger.sendCommand({ tabId: msg.tabId }, msg.method, msg.params ?? {})) ?? {};
    }
    default:
      throw new Error("unknown message type " + msg.type);
  }
}

function connect() {
  if (ws && ws.readyState <= 1) return;
  ws = new WebSocket(URL);
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
  };
  ws.onerror = () => {};
}

// The server may start after Chrome, so keep retrying.
chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
