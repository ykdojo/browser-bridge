// Thin relay: connects out to the local MCP server and forwards CDP commands
// to any tab. All agent logic lives in the server.
const URL = "ws://127.0.0.1:17333";
let ws = null;
let pingTimer = null;
const attached = new Set();

chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));
chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId));

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
    case "cdp": {
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
