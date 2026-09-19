#!/usr/bin/env node
// MCP server (stdio) that also hosts a localhost WebSocket for the Chrome Bridge
// extension. The extension connects out to us; we send it CDP commands.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";

const PORT = Number(process.env.BRIDGE_PORT ?? 17333);
const EXTENSION_ID = process.env.BRIDGE_EXTENSION_ID ?? "epjnmpnkphfbonblfmfeokijfhmjcfne";
const log = (...a) => console.error("[chrome-bridge]", ...a); // stdout belongs to MCP

// ---- extension link -------------------------------------------------------
// The first server to start owns the port and the extension connection (primary).
// Later servers (other agent sessions) connect to it as peers and get relayed.
// If the primary exits, a peer takes over the port and the extension reconnects.
const NOT_CONNECTED = "Chrome Bridge extension is not connected. Make sure Chrome is open and the extension is loaded, then retry in a few seconds.";
let ext = null; // primary: the extension's socket
let upstream = null; // peer: socket to the primary
let nextId = 0;
const pending = new Map();

function settle(data) {
  const m = JSON.parse(data);
  const p = pending.get(m.id);
  if (!p) return; // pings
  pending.delete(m.id);
  m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
}

function call(msg, timeoutMs = 30000) {
  const sock = ext ?? upstream;
  if (!sock || sock.readyState !== 1) return Promise.reject(new Error(NOT_CONNECTED));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const t = setTimeout(() => pending.delete(id) && reject(new Error("timed out waiting for the extension")), timeoutMs);
    pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
    sock.send(JSON.stringify({ ...msg, id }));
  });
}

function start() {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: PORT,
    // Browsers always send a truthful Origin, so this blocks web pages and other extensions.
    // Peers are local non-browser processes: no Origin, plus our header.
    verifyClient: ({ origin, req }) => origin === `chrome-extension://${EXTENSION_ID}` || (!origin && req.headers["x-bridge-peer"] === "1"),
  });
  wss.on("listening", () => log(`primary, waiting for extension on ws://127.0.0.1:${PORT}`));
  wss.on("error", (e) => {
    wss.close();
    if (e.code === "EADDRINUSE") return joinAsPeer();
    log(String(e));
    setTimeout(start, 2000);
  });
  wss.on("connection", (sock, req) => {
    if (req.headers["x-bridge-peer"] === "1") {
      sock.on("message", async (data) => {
        const { id, ...msg } = JSON.parse(data);
        try {
          sock.send(JSON.stringify({ id, result: await call(msg) }));
        } catch (e) {
          sock.send(JSON.stringify({ id, error: String(e?.message ?? e) }));
        }
      });
      return;
    }
    ext = sock;
    log("extension connected");
    sock.on("message", settle);
    sock.on("close", () => {
      if (ext === sock) ext = null;
      log("extension disconnected");
    });
  });
}

function joinAsPeer() {
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { "x-bridge-peer": "1" } });
  sock.on("open", () => {
    upstream = sock;
    log("peer of an existing chrome-bridge server");
  });
  sock.on("message", settle);
  sock.on("error", () => {});
  sock.on("close", () => {
    if (upstream === sock) upstream = null;
    setTimeout(start, 200 + Math.random() * 800); // primary may be gone: try to take over
  });
}
start();

const cdp = (tabId, method, params) => call({ type: "cdp", tabId, method, params });

// ---- page helpers ---------------------------------------------------------
const SKIP = new Set(["none", "generic", "InlineTextBox", "LineBreak", "presentation"]);

async function snapshot(tabId) {
  await cdp(tabId, "Accessibility.enable");
  const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree");
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const lines = [];
  const walk = (n, depth) => {
    const role = n.role?.value ?? "";
    const name = (n.name?.value ?? "").trim();
    const show = !n.ignored && !SKIP.has(role) && !(role === "StaticText" && !name);
    if (show) {
      const value = n.value?.value ? ` value="${String(n.value.value).slice(0, 80)}"` : "";
      const ref = n.backendDOMNodeId ? `[${n.backendDOMNodeId}] ` : "";
      lines.push(`${"  ".repeat(depth)}${ref}${role}${name ? ` "${name.slice(0, 120)}"` : ""}${value}`);
    }
    for (const c of n.childIds ?? []) byId.has(c) && walk(byId.get(c), show ? depth + 1 : depth);
  };
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  if (root) walk(root, 0);
  let text = lines.join("\n");
  if (text.length > 60000) text = text.slice(0, 60000) + "\n... (truncated)";
  return text;
}

async function center(tabId, ref) {
  await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref }).catch(() => {});
  const { model } = await cdp(tabId, "DOM.getBoxModel", { backendNodeId: ref });
  const q = model.content;
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

async function clickAt(tabId, x, y, clickCount = 1) {
  const base = { x, y, button: "left", clickCount };
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

const KEYS = {
  Enter: { code: "Enter", vk: 13, text: "\r" }, Tab: { code: "Tab", vk: 9 }, Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 }, Delete: { code: "Delete", vk: 46 }, Space: { key: " ", code: "Space", vk: 32, text: " " },
  ArrowUp: { code: "ArrowUp", vk: 38 }, ArrowDown: { code: "ArrowDown", vk: 40 }, ArrowLeft: { code: "ArrowLeft", vk: 37 }, ArrowRight: { code: "ArrowRight", vk: 39 },
  PageUp: { code: "PageUp", vk: 33 }, PageDown: { code: "PageDown", vk: 34 }, Home: { code: "Home", vk: 36 }, End: { code: "End", vk: 35 },
};

// ---- tools ----------------------------------------------------------------
const server = new McpServer({ name: "chrome-bridge", version: "0.1.0" });
const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 1) }] });
const tool = (name, description, shape, fn) =>
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return { isError: true, ...text(String(e?.message ?? e)) };
    }
  });
const tabId = z.number().int().describe("Tab id from list_tabs");
const ref = z.number().int().describe("Element ref: the [number] shown in snapshot output");

tool("list_tabs", "List the tabs available to the agent. By default that is every open tab; if the user switched to per-tab sharing, only tabs they shared by clicking the Chrome Bridge icon.", {}, async () =>
  text(await call({ type: "tabs.list" })));

tool("new_tab", "Open a new tab in the user's logged-in Chrome. The new tab is always available to the agent.", { url: z.string() }, async ({ url }) =>
  text(await call({ type: "tabs.create", url })));

tool("close_tab", "Close a shared tab.", { tabId }, async ({ tabId }) => text(await call({ type: "tabs.close", tabId })));

tool("navigate", "Navigate a shared tab to a URL and wait for it to load.", { tabId, url: z.string() }, async ({ tabId, url }) => {
  await cdp(tabId, "Page.enable");
  const r = await cdp(tabId, "Page.navigate", { url });
  if (r.errorText) throw new Error(r.errorText);
  for (let i = 0; i < 40; i++) {
    const { result } = await cdp(tabId, "Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
    if (result.value === "complete") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return text("navigated to " + url);
});

tool("snapshot", "Accessibility-tree snapshot of the page as text. Elements carry a [ref] number usable with click and type. Prefer this over screenshot.", { tabId }, async ({ tabId }) =>
  text(await snapshot(tabId)));

tool("click", "Click an element by ref (from snapshot), or at x/y page coordinates.", { tabId, ref: ref.optional(), x: z.number().optional(), y: z.number().optional(), double: z.boolean().optional() },
  async ({ tabId, ref, x, y, double }) => {
    const p = ref != null ? await center(tabId, ref) : { x, y };
    if (p.x == null || p.y == null) throw new Error("give either ref or both x and y");
    await clickAt(tabId, p.x, p.y, double ? 2 : 1);
    return text(`clicked at ${Math.round(p.x)},${Math.round(p.y)}`);
  });

tool("type", "Type text into the focused element. Pass ref to click and focus an element first. Set submit to press Enter after.", { tabId, text: z.string(), ref: ref.optional(), submit: z.boolean().optional() },
  async ({ tabId, text: t, ref, submit }) => {
    if (ref != null) {
      const p = await center(tabId, ref);
      await clickAt(tabId, p.x, p.y);
    }
    await cdp(tabId, "Input.insertText", { text: t });
    if (submit) await pressKey(tabId, "Enter");
    return text("typed");
  });

async function pressKey(tabId, key) {
  const k = KEYS[key] ?? { key, code: key.length === 1 ? "Key" + key.toUpperCase() : key, vk: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, text: key.length === 1 ? key : undefined };
  const base = { key: k.key ?? key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await cdp(tabId, "Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, text: k.text });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
tool("press_key", "Press a key, e.g. Enter, Tab, Escape, Backspace, ArrowDown, PageDown, or a single character.", { tabId, key: z.string() }, async ({ tabId, key }) => {
  await pressKey(tabId, key);
  return text("pressed " + key);
});

tool("screenshot", "JPEG screenshot of the visible part of the page. Use snapshot first; use this only when layout or visuals matter.", { tabId }, async ({ tabId }) => {
  const { data } = await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
  return { content: [{ type: "image", data, mimeType: "image/jpeg" }] };
});

tool("evaluate", "Run JavaScript in the page and return the result. Promises are awaited.", { tabId, expression: z.string() }, async ({ tabId, expression }) => {
  const r = await cdp(tabId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return text(r.result.value ?? r.result.description ?? "undefined");
});

await server.connect(new StdioServerTransport());
