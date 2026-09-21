#!/usr/bin/env node
// MCP server (stdio) that also hosts a localhost WebSocket for the Browser Bridge
// extension. The extension connects out to us; we send it CDP commands.
// Tool names and input shapes deliberately mirror Claude for Chrome's tool
// surface, since models are tuned for those shapes.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";

const PORT = Number(process.env.BRIDGE_PORT ?? 17333);
const EXTENSION_ID = process.env.BRIDGE_EXTENSION_ID ?? "epjnmpnkphfbonblfmfeokijfhmjcfne";
const log = (...a) => console.error("[browser-bridge]", ...a); // stdout belongs to MCP
const MIN_EXTENSION = "0.6.0"; // first extension version that reports dialogs and file pickers
const olderThan = (a, b) => a.localeCompare(b, undefined, { numeric: true }) < 0;

// ---- extension link -------------------------------------------------------
// The first server to start owns the port and the extension connection (primary).
// Later servers (other agent sessions) connect to it as peers and get relayed.
// If the primary exits, a peer takes over the port and the extension reconnects.
const NOT_CONNECTED = "Browser Bridge extension is not connected. Make sure Chrome is open and the extension is loaded, then retry in a few seconds.";
// primary: every connected extension (one per Chrome profile that has it
// loaded). The most recently connected one is active; clicking the extension
// icon in another profile makes that profile active instead.
const exts = new Set();
let ext = null; // primary: the active extension's socket
let upstream = null; // peer: socket to the primary
let nextId = 0;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function settle(m) {
  const p = pending.get(m.id);
  if (!p) return; // pings
  pending.delete(m.id);
  m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
}

// A socket that closes can never answer, so fail its calls now rather than
// letting them run into the 30s timeout.
function failPending(sock, reason) {
  for (const [id, p] of pending) if (p.sock === sock) (pending.delete(id), p.reject(new Error(reason)));
}

async function call(msg, timeoutMs = 30000) {
  // Right after startup or a takeover the extension needs a moment to reconnect.
  for (let i = 0; i < 20 && (ext ?? upstream)?.readyState !== 1; i++) await sleep(250);
  const sock = ext ?? upstream;
  if (!sock || sock.readyState !== 1) throw new Error(NOT_CONNECTED);
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const t = setTimeout(() => pending.delete(id) && reject(new Error("timed out waiting for the extension")), timeoutMs);
    pending.set(id, { sock, resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
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
    exts.add(sock);
    ext = sock;
    log(`extension connected (${exts.size} connected)`);
    sock.on("message", (data) => {
      const m = JSON.parse(data);
      if (m.type === "activate") {
        ext = sock;
        return log("extension activated by icon click");
      }
      settle(m);
    });
    sock.on("close", () => {
      exts.delete(sock);
      failPending(sock, "The Browser Bridge extension disconnected before answering. Retry in a few seconds.");
      if (ext === sock) ext = [...exts].at(-1) ?? null;
      log(`extension disconnected (${exts.size} connected)`);
    });
  });
}

function joinAsPeer() {
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { "x-bridge-peer": "1" } });
  sock.on("open", () => {
    upstream = sock;
    log("peer of an existing browser-bridge server");
  });
  sock.on("message", (data) => settle(JSON.parse(data)));
  sock.on("error", () => {});
  sock.on("close", () => {
    if (upstream === sock) upstream = null;
    failPending(sock, "Lost the connection to the primary Browser Bridge server. Retry in a few seconds.");
    setTimeout(start, 200 + Math.random() * 800); // primary may be gone: try to take over
  });
}
start();

// The extension piggybacks notices on command results: things that happened in
// the tab that the agent could not otherwise see, like a JavaScript dialog it
// dismissed. They are queued per tab and appended to the next tool result.
const notices = new Map(); // tabId -> notice objects
async function cdp(tabId, method, params) {
  const r = await call({ type: "cdp", tabId, method, params });
  if (r?.__bridgeNotices) {
    notices.set(tabId, [...(notices.get(tabId) ?? []), ...r.__bridgeNotices]);
    delete r.__bridgeNotices;
  }
  return r;
}

function describeNotice(n) {
  if (n.kind === "filechooser") return "The page tried to open a file picker, which was suppressed: native file dialogs can't be operated through this bridge, and file uploads aren't supported.";
  if (n.kind === "dialog") {
    const what = `A JavaScript ${n.dialogType} dialog${n.message ? ` ("${n.message}")` : ""}`;
    if (n.dialogType === "beforeunload") return n.accepted ? "The page's unsaved-changes prompt was accepted (force)." : "The page showed an unsaved-changes prompt and the bridge chose to stay on the page.";
    if (n.dialogType === "alert") return `${what} opened and was dismissed automatically.`;
    return `${what} opened and was cancelled automatically, since dialogs block the page. To answer it differently, override window.${n.dialogType} with javascript_tool before triggering it (e.g. window.confirm = () => true).`;
  }
  return JSON.stringify(n);
}

// ---- element refs ---------------------------------------------------------
// read_page and find hand out string refs like "ref_12". A ref maps to a CDP
// backendNodeId and stays stable for the same node within a tab.
const refMaps = new Map(); // tabId -> { byNode: Map, byRef: Map, n: counter }
function refFor(tabId, backendNodeId) {
  let m = refMaps.get(tabId);
  if (!m) refMaps.set(tabId, (m = { byNode: new Map(), byRef: new Map(), n: 0 }));
  let r = m.byNode.get(backendNodeId);
  if (!r) {
    r = `ref_${++m.n}`;
    m.byNode.set(backendNodeId, r);
    m.byRef.set(r, backendNodeId);
  }
  return r;
}
function nodeFor(tabId, ref) {
  const id = refMaps.get(tabId)?.byRef.get(ref);
  if (!id) throw new Error(`Unknown ref "${ref}". Call read_page or find first to get element refs for this tab.`);
  return id;
}

// ---- accessibility tree ---------------------------------------------------
const SKIP = new Set(["none", "generic", "InlineTextBox", "LineBreak", "presentation"]);
const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio",
  "switch", "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "textfield",
]);

async function axNodes(tabId) {
  await cdp(tabId, "Accessibility.enable");
  const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree");
  return nodes;
}

function buildTree(tabId, nodes, { filter = "all", depth = 15, refRoot = null } = {}) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const lines = [];
  const walk = (n, d, parentName = "") => {
    if (d > depth) return;
    const role = n.role?.value ?? "";
    const name = (n.name?.value ?? "").trim();
    const interactive = INTERACTIVE.has(role.toLowerCase());
    // aria-labelled containers (e.g. contenteditable divs) come through as role
    // "generic" but are real targets, so a name rescues a skipped role.
    let show = !n.ignored && (!SKIP.has(role) || (role === "generic" && !!name)) && !(role === "StaticText" && (!name || parentName.includes(name)));
    if (filter === "interactive" && !interactive) show = false;
    if (show) {
      const value = n.value?.value ? ` value="${String(n.value.value).slice(0, 80)}"` : "";
      const ref = n.backendDOMNodeId && (interactive || filter === "all") ? ` [${refFor(tabId, n.backendDOMNodeId)}]` : "";
      lines.push(`${"  ".repeat(filter === "interactive" ? 0 : d)}${role}${name ? ` "${name.slice(0, 120)}"` : ""}${value}${ref}`);
    }
    // In interactive mode containers are hidden but their children still count.
    const nd = show && filter !== "interactive" ? d + 1 : d;
    for (const c of n.childIds ?? []) byId.has(c) && walk(byId.get(c), nd, show ? name : parentName);
  };
  let root = nodes.find((n) => !n.parentId) ?? nodes[0];
  if (refRoot != null) {
    const target = nodeFor(tabId, refRoot);
    root = nodes.find((n) => n.backendDOMNodeId === target) ?? root;
  }
  if (root) walk(root, 0);
  return lines.join("\n");
}

function clip(textStr, maxChars, hint) {
  if (textStr.length <= maxChars) return textStr;
  const cut = textStr.lastIndexOf("\n", maxChars);
  return textStr.slice(0, cut > 0 ? cut : maxChars) + `\n... (truncated: full size ${textStr.length} chars. ${hint})`;
}

// ---- input helpers --------------------------------------------------------
async function center(tabId, backendNodeId) {
  await cdp(tabId, "DOM.getDocument", { depth: 0 }).catch(() => {});
  await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
  const { model } = await cdp(tabId, "DOM.getBoxModel", { backendNodeId });
  const q = model.content;
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

const MOD_BITS = { alt: 1, opt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, windows: 4, shift: 8 };
function modifierMask(mods) {
  let mask = 0;
  for (const m of (mods ?? "").split("+").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!(m in MOD_BITS)) throw new Error(`Unknown modifier "${m}"`);
    mask |= MOD_BITS[m];
  }
  return mask;
}

async function mouse(tabId, type, x, y, extra = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type, x, y, ...extra });
}

// ---- native UI guards -----------------------------------------------------
// Synthetic input can open operating-system UI (Chrome's context menu, <select>
// popups, file pickers) but can never close it: those only listen to real OS
// input. On macOS an open native menu even stalls tab closing for the whole
// browser. So the bridge never lets one open.

// Runs inside the page. Hit-tests the point (or, for mode "focus", the focused
// element) through same-origin iframes and open shadow roots.
function pageGuard(x, y, mode) {
  const popupSelect = (el) => {
    const s = el && el.closest && el.closest("select");
    return !!s && !s.multiple && s.size <= 1 && !s.disabled;
  };
  let el;
  if (mode === "focus") {
    el = document.activeElement;
    for (;;) {
      if (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      else if (el && (el.tagName === "IFRAME" || el.tagName === "FRAME")) {
        let d = null;
        try { d = el.contentDocument; } catch (e) {}
        if (!d) break;
        el = d.activeElement;
      } else break;
    }
    return popupSelect(el) ? { blocked: "select" } : {};
  }
  let w = window, ox = 0, oy = 0;
  const wins = [window];
  for (;;) {
    el = w.document.elementFromPoint(x - ox, y - oy);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x - ox, y - oy);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (!el || (el.tagName !== "IFRAME" && el.tagName !== "FRAME")) break;
    let inner = null;
    try { inner = el.contentDocument ? el.contentWindow : null; } catch (e) {}
    if (!inner) return mode === "right" ? { blocked: "cross-site-frame" } : {};
    const r = el.getBoundingClientRect();
    ox += r.left + el.clientLeft;
    oy += r.top + el.clientTop;
    w = inner;
    wins.push(w);
  }
  if (mode !== "right") return popupSelect(el) ? { blocked: "select" } : {};
  // Last listener on the last node of the bubble path: every page handler has
  // already run and seen defaultPrevented === false, so custom in-page context
  // menus behave normally. Only Chrome's own menu is cancelled.
  for (const win of wins) {
    const h = (e) => e.preventDefault();
    win.addEventListener("contextmenu", h);
    win.setTimeout(() => win.removeEventListener("contextmenu", h), 1500);
  }
  return {};
}

const NATIVE_UI = {
  select: "This is a native dropdown (<select>). Opening it shows an operating-system menu that can't be seen or operated through this bridge and that blocks the browser until a person closes it. Use form_input with the element's ref and the option's text or value instead.",
  "cross-site-frame": "Right-clicking inside a cross-site iframe isn't supported: it would open Chrome's native context menu, which blocks the browser until a person closes it.",
};

async function guard(tabId, x, y, mode) {
  // No script context (e.g. the PDF viewer): nothing to inspect, let the input through.
  const r = await evalJs(tabId, `(${pageGuard})(${Number(x)}, ${Number(y)}, ${JSON.stringify(mode)})`).catch(() => null);
  if (r?.value?.blocked) throw new Error(NATIVE_UI[r.value.blocked]);
}

// A click or keypress can make the page open a file picker. While interception
// is on, Chrome reports the request instead of showing the native dialog. It is
// only on for the duration of the input so a person using the tab is unaffected.
async function withFileChooserBlocked(tabId, fn) {
  const on = await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: true }).then(() => true, () => false);
  try {
    return await fn();
  } finally {
    if (on) await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  }
}

async function clickAt(tabId, x, y, { button = "left", clickCount = 1, modifiers = 0 } = {}) {
  await guard(tabId, x, y, button === "right" ? "right" : "left");
  await withFileChooserBlocked(tabId, async () => {
    await mouse(tabId, "mouseMoved", x, y, { modifiers });
    await mouse(tabId, "mousePressed", x, y, { button, clickCount, modifiers });
    await mouse(tabId, "mouseReleased", x, y, { button, clickCount, modifiers });
  });
}

const KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 }, escape: { key: "Escape", code: "Escape", vk: 27 }, esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 }, delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 }, up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 }, down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 }, right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 }, pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  home: { key: "Home", code: "Home", vk: 36 }, end: { key: "End", code: "End", vk: 35 },
};
// Native editing shortcuts don't fire from synthetic modifier+key events, so
// map the common ones to CDP editing commands.
const EDIT_COMMANDS = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo", y: "redo" };

async function pressKey(tabId, token) {
  const parts = token.split("+");
  const keyName = parts.pop();
  const modifiers = modifierMask(parts.join("+"));
  const lower = keyName.toLowerCase();
  const k = KEYS[lower] ??
    (keyName.length === 1
      ? { key: keyName, code: /[a-z]/i.test(keyName) ? "Key" + keyName.toUpperCase() : keyName, vk: keyName.toUpperCase().charCodeAt(0), text: modifiers ? undefined : keyName }
      : { key: keyName, code: keyName, vk: 0 });
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers };
  const commands = modifiers & (MOD_BITS.cmd | MOD_BITS.ctrl) && EDIT_COMMANDS[lower] ? [EDIT_COMMANDS[lower]] : undefined;
  await cdp(tabId, "Input.dispatchKeyEvent", { type: k.text && !modifiers ? "keyDown" : "rawKeyDown", ...base, text: modifiers ? undefined : k.text, commands });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function keySequence(tabId, text, repeat = 1) {
  const tokens = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < repeat; i++) for (const t of tokens) await pressKey(tabId, t);
  return tokens.length * repeat;
}

async function evalJs(tabId, expression) {
  // replMode gives top-level await and last-expression results, like the DevTools console.
  const r = await cdp(tabId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, replMode: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result;
}

// Screenshots are always 1 image pixel per CSS pixel, whatever the display's
// device pixel ratio, so coordinates read off a screenshot are valid click
// coordinates. `region` ([x0, y0, x1, y1] in viewport pixels) zooms instead.
async function screenshot(tabId, region) {
  const v = (await evalJs(tabId, "({sx: scrollX, sy: scrollY, w: innerWidth, h: innerHeight, dpr: devicePixelRatio})")).value;
  let clip;
  if (region) {
    const [x0, y0, x1, y1] = region;
    if (x1 <= x0 || y1 <= y0) throw new Error("region must run from top-left (x0, y0) to bottom-right (x1, y1)");
    const magnify = Math.min(3, Math.max(1, v.w / (x1 - x0)));
    clip = { x: v.sx + x0, y: v.sy + y0, width: x1 - x0, height: y1 - y0, scale: magnify / v.dpr };
  } else {
    clip = { x: v.sx, y: v.sy, width: v.w, height: v.h, scale: 1 / v.dpr };
  }
  const { data } = await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70, clip });
  return { content: [{ type: "image", data, mimeType: "image/jpeg" }] };
}

async function waitForLoad(tabId) {
  for (let i = 0; i < 40; i++) {
    const state = await evalJs(tabId, "document.readyState").catch(() => null);
    if (state?.value === "complete") return;
    await sleep(250);
  }
}

// ---- tools ----------------------------------------------------------------
const server = new McpServer({ name: "browser-bridge", version: "0.2.0" });
const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 1) }] });
function withNotices(tabId, result) {
  const queued = notices.get(tabId);
  if (!queued?.length) return result;
  notices.delete(tabId);
  const lines = [...new Set(queued.map(describeNotice))].map((l) => "Note: " + l);
  return { ...result, content: [...result.content, { type: "text", text: lines.join("\n") }] };
}
const tool = (name, description, shape, fn) =>
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    let result;
    try {
      result = await fn(args);
    } catch (e) {
      result = { isError: true, ...text(String(e?.message ?? e)) };
    }
    return withNotices(args?.tabId, result);
  });
const tabIdParam = z.number().describe("Tab ID to act on. Use tabs_context first if you don't have a valid tab ID.");
const refParam = z.string().describe('Element reference ID from the read_page or find tools (e.g., "ref_1", "ref_2")');

const controllable = (url) => /^(https?|file):/.test(url) && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url);

tool("tabs_context", "Get context information about all open tabs in the user's Chrome: tab IDs, titles, URLs and which tab is active. Call this before other browser tools so you know what tabs exist. Tabs marked controllable: false (browser pages like chrome://) can be seen but not read or acted on.", {}, async () => {
  const tabs = await call({ type: "tabs.list" });
  const result = text(tabs.map((t) => ({ ...t, controllable: controllable(t.url) })));
  // The server and the unpacked extension update separately; say so when they drift.
  const v = await call({ type: "version" }).then((r) => r?.version ?? "0", () => "0");
  if (olderThan(v, MIN_EXTENSION)) result.content.push({ type: "text", text: `Note: the Browser Bridge extension loaded in Chrome (${v === "0" ? "older than 0.6.0" : v}) is older than this server expects (${MIN_EXTENSION}). Until it is reloaded at chrome://extensions, JavaScript dialogs can freeze a tab and file-picker suppression goes unreported.` });
  return result;
});

tool("tabs_create", "Creates a new empty tab in the user's Chrome and returns its tab ID. Use navigate to load a URL in it.", {}, async () =>
  text(await call({ type: "tabs.create", url: "about:blank" })));

tool("tabs_close", "Close a tab by its tab ID. Get valid IDs from tabs_context.", { tabId: tabIdParam }, async ({ tabId }) => {
  try {
    return text(await call({ type: "tabs.close", tabId }, 10000));
  } catch (e) {
    if (!String(e.message).includes("timed out")) throw e;
    throw new Error("Chrome did not close the tab within 10s. Something native is probably open in the browser window, like a menu or a \"Leave site?\" prompt, and only a person can dismiss it. The tab will close once it is dismissed.");
  }
});

tool("navigate", "Navigate a tab to a URL, or go forward/back in browser history.", {
  url: z.string().describe('The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.'),
  tabId: tabIdParam,
  force: z.boolean().optional().describe("If the page blocks leaving because of unsaved changes, discard those changes and navigate anyway. Defaults to false."),
}, async ({ url, tabId, force }) => {
  await cdp(tabId, "Page.enable");
  refMaps.delete(tabId); // old refs die with the old document, even when the navigation fails (error page)
  // A page with unsaved changes answers a navigation with a "Leave site?"
  // prompt. The extension answers it for us: leave if forced, stay otherwise.
  if (force) await call({ type: "dialogs.policy", tabId, acceptBeforeunload: true }).catch(() => {});
  const stayed = () => {
    const queued = notices.get(tabId) ?? [];
    const i = queued.findIndex((n) => n.kind === "dialog" && n.dialogType === "beforeunload" && !n.accepted);
    if (i < 0) return false;
    queued.splice(i, 1);
    return true;
  };
  const BLOCKED = "The page asked to confirm leaving because of unsaved changes, so the navigation was cancelled and the tab is still on the same page. Pass force: true to discard the changes and navigate anyway.";
  if (url === "back" || url === "forward") {
    const { currentIndex, entries } = await cdp(tabId, "Page.getNavigationHistory");
    const target = entries[currentIndex + (url === "back" ? -1 : 1)];
    if (!target) throw new Error(`No ${url} entry in this tab's history`);
    await cdp(tabId, "Page.navigateToHistoryEntry", { entryId: target.id });
    await waitForLoad(tabId);
    if (stayed()) throw new Error(BLOCKED);
    return text(`went ${url} to ${target.url}`);
  }
  const full = /^[a-z]+:/i.test(url) ? url : `https://${url}`;
  const r = await cdp(tabId, "Page.navigate", { url: full });
  await waitForLoad(tabId);
  if (stayed()) throw new Error(BLOCKED);
  if (r.errorText) throw new Error(`${r.errorText} (${full})`);
  return text("navigated to " + full);
});

tool("read_page", "Get an accessibility tree representation of the page: a structured text tree of elements, the way a screen reader sees it. Elements carry reference IDs like [ref_3] usable with the computer, form_input and other tools. Prefer this over screenshots for reading and locating elements.", {
  tabId: tabIdParam,
  filter: z.enum(["interactive", "all"]).optional().describe('"interactive" for buttons/links/inputs only, "all" for every element (default: all)'),
  depth: z.number().optional().describe("Maximum tree depth to traverse (default: 15). Use a smaller depth if output is too large."),
  ref_id: z.string().optional().describe("Reference ID of a parent element: return only that element and its children. Use to focus on part of a large page."),
  max_chars: z.number().optional().describe("Maximum characters for output (default: 50000)."),
}, async ({ tabId, filter, depth, ref_id, max_chars }) => {
  const tree = buildTree(tabId, await axNodes(tabId), { filter: filter ?? "all", depth: depth ?? 15, refRoot: ref_id ?? null });
  return text(clip(tree, max_chars ?? 50000, "Pass a larger max_chars, or use depth/ref_id/filter to focus."));
});

tool("find", 'Find elements on the page by describing them: purpose (e.g. "search bar", "login button") or text content. Returns up to 20 matching elements with reference IDs usable with other tools.', {
  query: z.string().describe('Description of what to find (e.g., "search bar", "add to cart button")'),
  tabId: tabIdParam,
}, async ({ query, tabId }) => {
  const nodes = await axNodes(tabId);
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const n of nodes) {
    if (n.ignored || !n.backendDOMNodeId) continue;
    const role = (n.role?.value ?? "").toLowerCase();
    const name = (n.name?.value ?? "").trim();
    if ((SKIP.has(n.role?.value) && !(role === "generic" && name)) || (!name && !INTERACTIVE.has(role))) continue;
    // A text node that only repeats its parent's name (a button's label) is the same hit twice.
    if (role === "statictext" && (byId.get(n.parentId)?.name?.value ?? "").includes(name)) continue;
    const hay = `${role} ${name}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length;
    if (hay.includes(query.toLowerCase())) score += query.length; // phrase bonus
    if (score > 0) scored.push({ score: score + (INTERACTIVE.has(role) ? 1 : 0), role: n.role?.value, name: name.slice(0, 120), ref: refFor(tabId, n.backendDOMNodeId) });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return text(`No elements matched "${query}". Try read_page to see the page structure.`);
  const top = scored.slice(0, 20).map(({ role, name, ref }) => ({ role, name, ref }));
  return text(scored.length > 20 ? { note: `${scored.length} matches; showing top 20. Use a more specific query.`, matches: top } : top);
});

tool("form_input", "Set the value of a form element by its reference ID from read_page or find. Use booleans for checkboxes, the option value or visible text for selects, and strings/numbers for other inputs. Prefer this over clicking and typing for form fields.", {
  ref: refParam,
  value: z.union([z.string(), z.boolean(), z.number()]).describe("The value to set"),
  tabId: tabIdParam,
}, async ({ ref, value, tabId }) => {
  const backendNodeId = nodeFor(tabId, ref);
  const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId });
  const r = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function(v) {
      const fire = (el) => { el.dispatchEvent(new Event("input", {bubbles:true})); el.dispatchEvent(new Event("change", {bubbles:true})); };
      const tag = this.tagName;
      if (tag === "SELECT") {
        const opt = [...this.options].find(o => o.value === String(v) || o.text.trim() === String(v));
        if (!opt) return "no option matching " + JSON.stringify(v);
        this.value = opt.value; fire(this); return "selected " + opt.text.trim();
      }
      if (this.type === "checkbox" || this.type === "radio") { this.checked = Boolean(v); fire(this); return (this.checked ? "checked" : "unchecked"); }
      if (tag === "INPUT" || tag === "TEXTAREA") {
        const proto = tag === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(this, String(v)); fire(this); return "set value";
      }
      if (this.isContentEditable) { this.textContent = String(v); fire(this); return "set text"; }
      return "element is not a form input (" + tag + ")";
    }`,
    arguments: [{ value }],
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return text(`${r.result.value} on ${ref}`);
});

tool("get_page_text", "Extract the page's text content as plain text, prioritizing article/main content. Ideal for reading articles and text-heavy pages.", {
  tabId: tabIdParam,
  max_chars: z.number().optional().describe("Maximum characters for output (default: 50000)."),
}, async ({ tabId, max_chars }) => {
  const r = await evalJs(tabId, `(document.querySelector("article") ?? document.querySelector("main") ?? document.body)?.innerText ?? ""`);
  return text(clip(String(r.value ?? ""), max_chars ?? 50000, "Pass a larger max_chars to get more."));
});

tool("javascript_tool", "Execute JavaScript in the page's context: it can read and modify the DOM, call page functions and use page variables. The result of the last expression is returned (top-level await works); write the expression you want rather than `return ...`.", {
  action: z.literal("javascript_exec").describe("Must be set to 'javascript_exec'"),
  text: z.string().describe("The JavaScript code to execute"),
  tabId: tabIdParam,
}, async ({ text: code, tabId }) => {
  const r = await evalJs(tabId, code);
  return text(r.value !== undefined ? r.value : r.description ?? "undefined");
});

tool("read_console_messages", "Read browser console messages (console.log/warn/error, uncaught exceptions) from a tab. Capture starts the first time a tool touches the tab, so reload the page after that if you need messages from page load. Always provide a pattern to avoid a flood of irrelevant messages.", {
  tabId: tabIdParam,
  onlyErrors: z.boolean().optional().describe("Only return error and exception messages (default: false)."),
  clear: z.boolean().optional().describe("Clear stored messages after reading, to avoid duplicates on later calls (default: false)."),
  pattern: z.string().optional().describe("Regex to filter messages, e.g. 'error|warning' or 'MyApp'."),
}, async ({ tabId, onlyErrors, clear, pattern }) => {
  const { entries, justAttached } = await call({ type: "console.read", tabId, clear: clear ?? false });
  let out = entries;
  if (onlyErrors) out = out.filter((e) => e.level === "error");
  if (pattern) {
    const re = new RegExp(pattern, "i");
    out = out.filter((e) => re.test(e.text));
  }
  const lines = out.map((e) => `[${new Date(e.ts).toISOString().slice(11, 19)}] ${e.level}: ${e.text}`);
  const note = justAttached ? "Capture just started for this tab: only messages from now on are recorded. Reload the page to capture load-time messages.\n" : "";
  return text(note + (lines.length ? clip(lines.join("\n"), 50000, "Filter with pattern or set clear:true.") : "no matching console messages"));
});

tool("read_network_requests", "Read HTTP requests (XHR/fetch, documents, images, ...) made by a tab, with method, URL, status and type. Capture starts the first time a tool touches the tab, so reload the page after that if you need requests from page load. Stored requests reset when the tab navigates to a different site.", {
  tabId: tabIdParam,
  urlPattern: z.string().optional().describe("Only return requests whose URL contains this string, e.g. '/api/' or 'example.com'."),
  clear: z.boolean().optional().describe("Clear stored requests after reading, to avoid duplicates on later calls (default: false)."),
  limit: z.number().optional().describe("Maximum number of requests to return (default: 100)."),
}, async ({ tabId, urlPattern, clear, limit }) => {
  const { entries, justAttached } = await call({ type: "network.read", tabId, clear: clear ?? false });
  let out = entries;
  if (urlPattern) out = out.filter((e) => e.url.includes(urlPattern));
  const total = out.length;
  out = out.slice(-(limit ?? 100));
  const lines = out.map((e) => `${e.method} ${e.url.slice(0, 300)} -> ${e.failed ? "FAILED " + e.failed : e.status ?? "pending"}${e.mimeType ? " " + e.mimeType : ""} (${e.resourceType})`);
  const note = (justAttached ? "Capture just started for this tab: only requests from now on are recorded. Reload the page to capture load-time requests.\n" : "") +
    (total > out.length ? `Showing last ${out.length} of ${total} matching requests.\n` : "");
  return text(note + (lines.length ? lines.join("\n") : "no matching network requests"));
});

const computerActions = ["left_click", "right_click", "type", "screenshot", "wait", "scroll", "key", "left_click_drag", "double_click", "triple_click", "zoom", "scroll_to", "hover"];
tool("computer", "Use a mouse and keyboard to interact with the page in a tab, and take screenshots. Click by element ref (from read_page or find) or by screenshot coordinates. If you don't have a valid tab ID, use tabs_context first.", {
  action: z.enum(computerActions).describe("The action to perform:\n* `left_click`/`right_click`/`double_click`/`triple_click`: click at `coordinate` or on `ref`. A right click reaches the page (custom in-page context menus work) but Chrome's own context menu is suppressed, since it can't be seen or used here. Native <select> dropdowns can't be clicked open: set them with form_input.\n* `type`: type `text` into the focused element.\n* `key`: press key(s) given in `text`, e.g. \"Enter\", \"Tab Tab\", \"cmd+a\".\n* `screenshot`: screenshot the visible page.\n* `zoom`: screenshot just the `region`, magnified.\n* `scroll`: scroll at `coordinate` in `scroll_direction`.\n* `scroll_to`: scroll the element `ref` into view.\n* `hover`: move the mouse to `coordinate` or `ref` without clicking.\n* `left_click_drag`: drag from `start_coordinate` to `coordinate`.\n* `wait`: wait `duration` seconds."),
  coordinate: z.array(z.number()).min(2).max(2).optional().describe("(x, y) in pixels from the top-left of the viewport. Required for scroll and left_click_drag; for clicks give either coordinate or ref, not both."),
  text: z.string().optional().describe('Text to type (for `type`) or key(s) to press (for `key`). Keys are space-separated (e.g. "Backspace Backspace"); combos use "+" with cmd/ctrl/alt/shift (e.g. "cmd+a").'),
  duration: z.number().min(0).max(10).optional().describe("Seconds to wait. Required for `wait`, max 10."),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional().describe("Direction to scroll. Required for `scroll`."),
  scroll_amount: z.number().min(1).max(10).optional().describe("Scroll wheel ticks (default 3)."),
  start_coordinate: z.array(z.number()).min(2).max(2).optional().describe("(x, y) start position for `left_click_drag`."),
  region: z.array(z.number()).min(4).max(4).optional().describe("(x0, y0, x1, y1) viewport rectangle to capture for `zoom`."),
  repeat: z.number().min(1).max(100).optional().describe("Times to repeat the key sequence (`key` action only, default 1)."),
  ref: z.string().optional().describe('Element reference ID from read_page or find (e.g. "ref_1"). Required for scroll_to; usable instead of coordinate for clicks and hover.'),
  modifiers: z.string().optional().describe('Modifier keys held during clicks: "ctrl", "shift", "alt", "cmd", combined with "+" (e.g. "cmd+shift").'),
  tabId: tabIdParam,
}, async (a) => {
  const { action, tabId } = a;
  const point = async (need = true) => {
    if (a.ref != null && a.coordinate != null) throw new Error("give either ref or coordinate, not both");
    if (a.ref != null) return center(tabId, nodeFor(tabId, a.ref));
    if (a.coordinate) return { x: a.coordinate[0], y: a.coordinate[1] };
    if (need) throw new Error(`${action} needs a coordinate or ref`);
    return null;
  };
  switch (action) {
    case "left_click": case "right_click": case "double_click": case "triple_click": {
      const p = await point();
      const button = action === "right_click" ? "right" : "left";
      const clickCount = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
      await clickAt(tabId, p.x, p.y, { button, clickCount, modifiers: modifierMask(a.modifiers) });
      return text(`${action} at ${Math.round(p.x)},${Math.round(p.y)}`);
    }
    case "type":
      if (a.text == null) throw new Error("type needs text");
      await cdp(tabId, "Input.insertText", { text: a.text });
      return text("typed");
    case "key": {
      if (!a.text) throw new Error('key needs text, e.g. "Enter" or "cmd+a"');
      // These keys open a focused <select>'s native popup.
      if (/(^|[\s+])(enter|return|space|arrowup|arrowdown|up|down)(\s|$)/i.test(a.text)) await guard(tabId, 0, 0, "focus");
      const n = await withFileChooserBlocked(tabId, () => keySequence(tabId, a.text, a.repeat ?? 1));
      return text(`pressed ${n} key(s): ${a.text}`);
    }
    case "wait":
      if (a.duration == null) throw new Error("wait needs duration");
      await sleep(Math.min(a.duration, 10) * 1000);
      return text(`waited ${Math.min(a.duration, 10)}s`);
    case "screenshot":
      return screenshot(tabId);
    case "zoom":
      if (!a.region) throw new Error("zoom needs region [x0,y0,x1,y1]");
      return screenshot(tabId, a.region);
    case "scroll": {
      if (!a.scroll_direction) throw new Error("scroll needs scroll_direction");
      const p = (await point(false)) ?? await evalJs(tabId, "({x: window.innerWidth/2, y: window.innerHeight/2})").then((r) => r.value);
      const d = (a.scroll_amount ?? 3) * 120;
      const [dx, dy] = { up: [0, -d], down: [0, d], left: [-d, 0], right: [d, 0] }[a.scroll_direction];
      await mouse(tabId, "mouseWheel", p.x, p.y, { deltaX: dx, deltaY: dy });
      // The wheel event returns before the scroll lands; without this a
      // screenshot or read right after would still show the old position.
      await sleep(300);
      return text(`scrolled ${a.scroll_direction}`);
    }
    case "scroll_to": {
      if (!a.ref) throw new Error("scroll_to needs ref");
      await center(tabId, nodeFor(tabId, a.ref));
      return text(`scrolled ${a.ref} into view`);
    }
    case "hover": {
      const p = await point();
      await mouse(tabId, "mouseMoved", p.x, p.y);
      return text(`hovering at ${Math.round(p.x)},${Math.round(p.y)}`);
    }
    case "left_click_drag": {
      if (!a.start_coordinate || !a.coordinate) throw new Error("left_click_drag needs start_coordinate and coordinate");
      const [sx, sy] = a.start_coordinate, [ex, ey] = a.coordinate;
      await mouse(tabId, "mouseMoved", sx, sy);
      await mouse(tabId, "mousePressed", sx, sy, { button: "left", clickCount: 1 });
      const steps = 8;
      for (let i = 1; i <= steps; i++) await mouse(tabId, "mouseMoved", sx + ((ex - sx) * i) / steps, sy + ((ey - sy) * i) / steps, { button: "left" });
      await mouse(tabId, "mouseReleased", ex, ey, { button: "left", clickCount: 1 });
      return text(`dragged from ${sx},${sy} to ${ex},${ey}`);
    }
  }
});

await server.connect(new StdioServerTransport());
