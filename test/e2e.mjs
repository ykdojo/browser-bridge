// End-to-end test through the real extension and Chrome: every tool, every
// computer action, element refs AND pixel coordinates, error paths. Needs
// Chrome running with the Browser Bridge extension loaded. Works whether the
// spawned server ends up primary or a peer of a live one, and only touches a
// throwaway tab that it closes afterwards.
import { spawn, execSync } from "child_process";
import { createServer } from "http";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const WebSocket = require("ws");
const jpeg = require("jpeg-js");
const SERVER = new URL("../server/index.js", import.meta.url).pathname;
const PAGE = "http://127.0.0.1:18444/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const html = readFileSync(new URL("./test-page.html", import.meta.url));
const http = createServer((req, res) => res.end(html)).listen(18444, "127.0.0.1");

function mcpClient() {
  const p = spawn(process.execPath, [SERVER]);
  const c = { p, log: "" };
  p.stderr.on("data", (d) => (c.log += d));
  let buf = ""; const waiters = new Map(); let nextId = 0;
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiters.get(m.id)?.(m); } catch {} } });
  c.rpc = (method, params) => new Promise((res, rej) => { const id = ++nextId; waiters.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => waiters.has(id) && rej(new Error(`${method} ${params?.name ?? ""} timed out`)), 45000); });
  c.call = async (name, args = {}) => {
    const r = await c.rpc("tools/call", { name, arguments: args });
    const texts = (r.result?.content ?? []).filter((x) => x.type === "text").map((x) => x.text);
    // txt is the tool's own answer; all also has any "Note:" blocks appended by the server.
    return { txt: texts[0] ?? "", all: texts.join("\n"), img: r.result?.content?.find((x) => x.type === "image"), err: !!(r.result?.isError || r.error), rpcErr: r.error?.message };
  };
  c.init = async () => {
    await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return c;
  };
  return c;
}

// A raw message through the relay, for test setup the 12 tools don't expose
// (display emulation, extension version and reload).
function raw(msg) {
  return new Promise((res, rej) => {
    const ws = new WebSocket("ws://127.0.0.1:17333", { headers: { "x-bridge-peer": "1" } });
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, ...msg })));
    ws.on("message", (d) => { const m = JSON.parse(d); ws.close(); m.error ? rej(new Error(m.error)) : res(m.result); });
    ws.on("error", rej);
  });
}
const rawCdp = (tabId, method, params = {}) => raw({ type: "cdp", tabId, method, params });

// Operating-system UI that synthetic input must never open: Chrome's native
// menus sit at the pop-up menu window level (101), file pickers belong to the
// system's panel service. Counting windows needs no permissions. macOS only.
const JXA = `ObjC.import("CoreGraphics"); const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)); let menus = 0, panels = 0; for (let i = 0; i < list.count; i++) { const w = ObjC.deepUnwrap(list.objectAtIndex(i)); const o = String(w.kCGWindowOwnerName); if (o.includes("Chrome") && w.kCGWindowLayer == 101) menus++; if (o.includes("Open and Save Panel")) panels++; } JSON.stringify({menus: menus, panels: panels})`;
const nativeUi = () => (process.platform === "darwin" ? JSON.parse(execSync(`osascript -l JavaScript -e '${JXA}'`).toString()) : null);
const noNativeUi = async () => { await sleep(600); const n = nativeUi(); return n === null || (n.menus === 0 && n.panels === 0); };

// What an agent does with a screenshot: look at the pixels, pick a point.
function locate(img, match) {
  const { width, height, data } = jpeg.decode(Buffer.from(img.data, "base64"), { useTArray: true });
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    const i = (y * width + x) * 4;
    if (match(data[i], data[i + 1], data[i + 2])) { sx += x; sy += y; n++; }
  }
  return { width, height, n, x: n ? sx / n : null, y: n ? sy / n : null };
}
const magenta = (r, g, b) => r > 200 && g < 90 && b > 200;
const lime = (r, g, b) => r < 90 && g > 200 && b < 90;

let pass = 0, fail = 0;
const check = (label, ok, info = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${info !== "" ? "  -- " + info : ""}`); };
const section = (name) => console.log(`\n# ${name}`);

const c = await mcpClient().init();
const { call } = c;
let tabId = null;
const js = async (code) => (await call("javascript_tool", { action: "javascript_exec", tabId, text: code })).txt;
const events = async () => JSON.parse(await js("JSON.stringify(window.events.splice(0))"));
const rect = async (id) => JSON.parse(await js(`JSON.stringify(document.getElementById("${id}").getBoundingClientRect())`));
const val = (id) => js(`document.getElementById("${id}").value`);
const computer = (args) => call("computer", { tabId, ...args });
const selectAll = process.platform === "darwin" ? "cmd+a" : "ctrl+a";

try {
  section("connection");
  let ctx;
  for (let i = 0; i < 45; i++) { ctx = await call("tabs_context"); if (!ctx.err) break; await sleep(1000); }
  check("extension reachable", !ctx.err, ctx.err ? ctx.txt : c.log.includes("primary") ? "this server is primary" : "this server is a peer");
  if (ctx.err) throw new Error("no extension connection; is Chrome running with Browser Bridge loaded?");

  // Test the extension code that is on disk, not whatever Chrome loaded earlier.
  const onDisk = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url))).version;
  const loadedVersion = () => raw({ type: "version" }).then((r) => r.version, () => null);
  let loaded = await loadedVersion();
  if (loaded) {
    await raw({ type: "reload" }).catch(() => {});
    loaded = null;
    for (let i = 0; i < 40 && loaded !== onDisk; i++) { await sleep(1000); loaded = await loadedVersion(); }
  }
  check("extension reloaded from disk", loaded === onDisk, loaded ? `${loaded}, on disk ${onDisk}` : "the loaded extension predates the reload command: reload it once by hand at chrome://extensions");
  if (loaded !== onDisk) throw new Error("extension out of date");
  const ui0 = nativeUi();
  check("no native menu or file picker open beforehand", !ui0 || (ui0.menus === 0 && ui0.panels === 0), ui0 ? JSON.stringify(ui0) : "not macOS: native UI checks are skipped");
  if (ui0 && (ui0.menus || ui0.panels)) throw new Error("a native menu or dialog is open in Chrome: click inside the window to dismiss it, then rerun");

  tabId = JSON.parse((await call("tabs_create")).txt).tabId;
  check("tabs_create", Number.isInteger(tabId));
  check("navigate", !(await call("navigate", { tabId, url: PAGE })).err);

  section("read_page / find / get_page_text");
  const all = (await call("read_page", { tabId })).txt;
  check("read_page all", all.includes("Bridge Test Page") && all.includes('button "Click me"'));
  const inter = (await call("read_page", { tabId, filter: "interactive" })).txt;
  check("read_page interactive", inter.includes("button") && !inter.includes("heading"));
  const d0 = (await call("read_page", { tabId, depth: 0 })).txt;
  check("read_page depth=0", d0.includes("RootWebArea") && !d0.includes("Click me"));
  const clipped = (await call("read_page", { tabId, max_chars: 200 })).txt;
  check("read_page max_chars", clipped.includes("truncated") && clipped.length < 400);
  const refIn = (tree, label) => tree.split("\n").find((l) => l.includes(label))?.match(/\[(ref_\d+)\]/)?.[1];
  const ref = (label) => refIn(inter, label);
  const focus = (await call("read_page", { tabId, ref_id: ref('"Test select"') })).txt;
  check("read_page ref_id", focus.includes("Alpha") && !focus.includes("Click me"));

  const found = JSON.parse((await call("find", { query: "click me button", tabId })).txt);
  check("find ranks best match first", found[0]?.name === "Click me" && found[0]?.role === "button");
  check("find does not repeat a label as its own hit", found.filter((f) => f.name === "Click me").length === 1, JSON.stringify(found.map((f) => f.role)));
  const editor = JSON.parse((await call("find", { query: "Editor", tabId })).txt)[0];
  check("find aria-labelled contenteditable", editor?.name === "Editor");
  check("find no match", (await call("find", { query: "zqxwv nonexistent widget", tabId })).txt.includes("No elements matched"));

  check("get_page_text", (await call("get_page_text", { tabId })).txt.includes("Bridge Test Page"));
  check("get_page_text max_chars", (await call("get_page_text", { tabId, max_chars: 20 })).txt.includes("truncated"));

  section("clicks by element ref");
  const btn = ref('"Click me"');
  await computer({ action: "left_click", ref: btn });
  await computer({ action: "double_click", ref: btn });
  await computer({ action: "right_click", ref: btn });
  await computer({ action: "left_click", ref: btn, modifiers: "shift+alt" });
  let ev = await events();
  check("left_click", ev.some((e) => e.type === "click" && e.id === "btn" && !e.mods));
  check("double_click", ev.some((e) => e.type === "dblclick"));
  check("right_click", ev.some((e) => e.type === "contextmenu" && e.button === 2));
  check("click with modifiers", ev.some((e) => e.type === "click" && e.mods === "shift+alt"));

  section("native UI never opens (it could not be closed again)");
  check("right_click: page handler saw an unprevented event", ev.some((e) => e.type === "contextmenu" && e.prevented === false));
  check("right_click: Chrome's own menu stayed closed", await noNativeUi());
  await computer({ action: "right_click", ref: ref('"Custom menu zone"') });
  check("right_click: page-drawn context menus still work", (await js(`getComputedStyle(document.getElementById("custommenu")).display`)) === "block");
  await js(`document.getElementById("custommenu").style.display = "none"`);
  const fr = await rect("frame");
  await computer({ action: "left_click", coordinate: [fr.x + 60, fr.y + 32] });
  check("coordinate click reaches into an iframe", (await events()).some((e) => e.type === "click" && e.id === "framebtn"));
  await computer({ action: "right_click", coordinate: [fr.x + 60, fr.y + 32] });
  check("right_click inside an iframe: event fires, no native menu", (await events()).some((e) => e.type === "contextmenu" && e.id === "framebtn") && (await noNativeUi()));
  const selClick = await computer({ action: "left_click", ref: ref('"Test select"') });
  check("clicking a <select> is refused with guidance", selClick.err && selClick.txt.includes("form_input"));
  const sr0 = await rect("sel");
  check("same by coordinate", (await computer({ action: "left_click", coordinate: [sr0.x + 10, sr0.y + 8] })).err);
  await js(`document.getElementById("sel").focus()`);
  check("keys that open a focused <select> are refused", (await computer({ action: "key", text: "ArrowDown" })).err && (await computer({ action: "key", text: "Space" })).err);
  check("no dropdown opened", await noNativeUi());
  const fileClick = await computer({ action: "left_click", ref: ref('"Upload file"') });
  check("file input click: picker suppressed and reported", !fileClick.err && fileClick.all.includes("file picker") && (await noNativeUi()), fileClick.all.slice(0, 80));
  const scriptClick = await computer({ action: "left_click", ref: ref('"Upload via script"') });
  check("script-opened picker: suppressed and reported", (await events()).some((e) => e.type === "script-upload-clicked") && scriptClick.all.includes("file picker") && (await noNativeUi()));
  await js(`document.getElementById("file").focus()`);
  const fileKey = await computer({ action: "key", text: "Enter" });
  check("picker opened by keyboard: suppressed", !fileKey.err && (await noNativeUi()));

  section("JavaScript dialogs never freeze the tab");
  let t1 = Date.now();
  const alertClick = await computer({ action: "left_click", ref: ref('"Show alert"') });
  check("alert: click returns, dialog reported", !alertClick.err && Date.now() - t1 < 8000 && alertClick.all.includes('alert dialog ("hello-alert")'), `${Date.now() - t1}ms`);
  check("alert: page continued", (await events()).some((e) => e.type === "alert-returned"));
  const confirmClick = await computer({ action: "left_click", ref: ref('"Show confirm"') });
  ev = await events();
  check("confirm: cancelled, reported with a way to accept", ev.some((e) => e.type === "confirm-returned" && e.value === false) && confirmClick.all.includes("window.confirm"));
  await js(`window.confirm = () => true; "overridden"`);
  const confirm2 = await computer({ action: "left_click", ref: ref('"Show confirm"') });
  check("confirm: the documented override works", (await events()).some((e) => e.type === "confirm-returned" && e.value === true) && !confirm2.all.includes("Note:"));
  await computer({ action: "left_click", ref: ref('"Show prompt"') });
  check("prompt: cancelled", (await events()).some((e) => e.type === "prompt-returned" && e.value === null));
  await js(`setTimeout(() => alert("late-alert"), 3500); "armed"`);
  await sleep(5500); // the agent is idle when this one opens, so it stays up like it would for a person
  t1 = Date.now();
  const afterLate = await call("javascript_tool", { action: "javascript_exec", tabId, text: "1 + 1" });
  check("a dialog already open is cleared by the next command", afterLate.txt === "2" && Date.now() - t1 < 8000 && afterLate.all.includes("late-alert"), `${Date.now() - t1}ms`);

  section("clicks by pixel coordinate");
  const r0 = await rect("btn");
  await computer({ action: "left_click", coordinate: [r0.x + r0.width / 2, r0.y + r0.height / 2] });
  check("coordinate from layout", (await events()).some((e) => e.type === "click" && e.id === "btn"));

  const vp = JSON.parse(await js("JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})"));
  let shot = await computer({ action: "screenshot" });
  let hit = locate(shot.img, magenta);
  check("screenshot is 1 image px per CSS px", Math.abs(hit.width - vp.w) <= 1 && Math.abs(hit.height - vp.h) <= 1, `${hit.width}x${hit.height} vs viewport ${vp.w}x${vp.h} @${vp.dpr}x`);
  await computer({ action: "left_click", coordinate: [hit.x, hit.y] });
  check("coordinate read off screenshot pixels", (await events()).some((e) => e.type === "click" && e.id === "pixeltarget"), `target found at ${Math.round(hit.x)},${Math.round(hit.y)}`);

  await rawCdp(tabId, "Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false });
  const dpr2 = Number(await js("devicePixelRatio"));
  shot = await computer({ action: "screenshot" });
  hit = locate(shot.img, magenta);
  check("2x display: screenshot still 1:1", dpr2 === 2 && Math.abs(hit.width - vp.w) <= 1 && Math.abs(hit.height - vp.h) <= 1, `${hit.width}x${hit.height} @${dpr2}x`);
  await computer({ action: "left_click", coordinate: [hit.x, hit.y] });
  check("2x display: screenshot pixel click lands", (await events()).some((e) => e.type === "click" && e.id === "pixeltarget"));
  await rawCdp(tabId, "Emulation.clearDeviceMetricsOverride");

  section("keyboard");
  await computer({ action: "left_click", ref: ref('"Test input"') });
  await computer({ action: "type", text: "hello bridge" });
  check("type", (await val("txt")) === "hello bridge");
  check("type fires input events", (await events()).some((e) => e.type === "input" && e.id === "txt"));
  await computer({ action: "key", text: "Backspace", repeat: 6 });
  check("key with repeat", (await val("txt")) === "hello ");
  await computer({ action: "key", text: selectAll });
  await computer({ action: "type", text: "replaced" });
  check("select-all shortcut", (await val("txt")) === "replaced");
  await computer({ action: "key", text: "x y z" });
  check("key sequence of characters", (await val("txt")) === "replacedxyz");
  await computer({ action: "triple_click", ref: ref('"Test input"') });
  check("triple_click selects the field", (await js(`(e => e.selectionEnd - e.selectionStart)(document.getElementById("txt"))`)) === "11");
  await computer({ action: "key", text: "Tab" });
  check("Tab moves focus", (await js("document.activeElement.id")) === "num");
  await computer({ action: "left_click", ref: ref('"Test input"') });
  await events();
  await computer({ action: "key", text: "Enter" });
  check("Enter submits the form", (await events()).some((e) => e.type === "submit"));
  await computer({ action: "left_click", ref: ref('"Notes"') });
  await computer({ action: "type", text: "line1\nline2 ✓" });
  check("type multi-line unicode", (await val("area")) === "line1\nline2 ✓");

  section("form_input");
  const fi = (label, value) => call("form_input", { tabId, ref: ref(label), value });
  await fi('"Test input"', "via form_input");
  check("text", (await val("txt")) === "via form_input");
  await fi('"Quantity"', 42);
  check("number", (await val("num")) === "42");
  await fi('"Notes"', "note text");
  check("textarea", (await val("area")) === "note text");
  await fi('"Subscribe"', true);
  const on = await js(`document.getElementById("chk").checked`);
  await fi('"Subscribe"', false);
  check("checkbox on and off", on === "true" && (await js(`document.getElementById("chk").checked`)) === "false");
  await fi('"Medium"', true);
  check("radio", (await js(`document.querySelector("[name=size]:checked")?.value`)) === "m");
  await events();
  await fi('"Test select"', "Beta");
  check("select by visible text, fires change", (await val("sel")) === "b" && (await events()).some((e) => e.type === "change"));
  await fi('"Test select"', "g");
  check("select by value", (await val("sel")) === "g");
  await call("form_input", { tabId, ref: editor.ref, value: "edited content" });
  check("contenteditable", (await js(`document.getElementById("ce").textContent`)) === "edited content");
  check("missing option reported", (await fi('"Test select"', "Zeta")).txt.includes("no option matching"));
  check("non-form element reported", (await call("form_input", { tabId, ref: refIn(all, "heading"), value: "x" })).txt.includes("not a form input"));

  section("hover / drag / scroll");
  const hz = await rect("hoverzone");
  await computer({ action: "hover", coordinate: [hz.x + 20, hz.y + 20] });
  check("hover", (await js(`document.getElementById("hoverzone").className`)) === "hovered");
  const b0 = await rect("dragbox");
  await computer({ action: "left_click_drag", start_coordinate: [b0.x + 30, b0.y + 30], coordinate: [b0.x + 150, b0.y + 30] });
  const b1 = await rect("dragbox");
  check("left_click_drag", Math.abs(b1.x - b0.x - 120) < 5, `moved ${Math.round(b1.x - b0.x)}px`);

  // No sleeps after scrolls: the tool itself must return only once the scroll has landed.
  const sr = await rect("scroller");
  await computer({ action: "scroll", scroll_direction: "down", coordinate: [sr.x + 50, sr.y + 50] });
  const nested = JSON.parse(await js(`JSON.stringify({inner: document.getElementById("scroller").scrollTop, page: scrollY})`));
  check("scroll targets the element under the pointer", nested.inner > 0 && nested.page === 0, JSON.stringify(nested));
  await computer({ action: "scroll", scroll_direction: "down", scroll_amount: 5, coordinate: [900, 300] });
  const y1 = Number(await js("scrollY"));
  check("scroll down, settled on return", y1 > 0, `scrollY=${Math.round(y1)}`);
  await computer({ action: "scroll", scroll_direction: "right", scroll_amount: 5, coordinate: [900, 300] });
  check("scroll right", Number(await js("scrollX")) > 0);
  await computer({ action: "scroll", scroll_direction: "left", scroll_amount: 10, coordinate: [900, 300] });
  await computer({ action: "scroll", scroll_direction: "up", scroll_amount: 10, coordinate: [900, 300] });
  check("scroll up and left back to origin", (await js("scrollX + ',' + scrollY")) === "0,0");

  section("scrolled page: scroll_to, screenshot and zoom offsets");
  const low = JSON.parse((await call("find", { query: "Low target", tabId })).txt)[0];
  await computer({ action: "scroll_to", ref: low.ref });
  const lr = await rect("lowtarget");
  check("scroll_to brings element into view", Number(await js("scrollY")) > 0 && lr.top >= 0 && lr.bottom <= vp.h);
  shot = await computer({ action: "screenshot" });
  hit = locate(shot.img, lime);
  check("scrolled screenshot shows the current viewport", hit.n > 100 && Math.abs(hit.x - (lr.x + 40)) < 4 && Math.abs(hit.y - (lr.y + 40)) < 4, `pixels say ${Math.round(hit.x)},${Math.round(hit.y)}; layout says ${Math.round(lr.x + 40)},${Math.round(lr.y + 40)}`);
  await computer({ action: "left_click", coordinate: [hit.x, hit.y] });
  check("pixel click on a scrolled page", (await events()).some((e) => e.type === "click" && e.id === "lowtarget"));
  const zoom = await computer({ action: "zoom", region: [lr.x, lr.y, lr.x + 80, lr.y + 80] });
  const z = locate(zoom.img, lime);
  check("zoom captures exactly the region, magnified", Math.abs(z.width - 240) <= 2 && Math.abs(z.height - 240) <= 2 && z.n > (z.width * z.height) / 4 * 0.9, `${z.width}x${z.height}, ${Math.round((z.n * 4 * 100) / (z.width * z.height))}% target color`);
  await computer({ action: "scroll_to", ref: refIn(all, "very bottom") });
  check("scroll_to far element", (await js(`(r => r.top >= 0 && r.bottom <= innerHeight)(document.getElementById("bottom").getBoundingClientRect())`)) === "true");

  const t0 = Date.now();
  await computer({ action: "wait", duration: 1 });
  check("wait", Date.now() - t0 >= 950);

  section("console / network");
  await js(`console.log("plainlog"); console.warn("warnlog"); console.error("boom-error"); setTimeout(() => { throw new Error("uncaught-boom") }, 0); undefined`);
  await sleep(500);
  const logs = (await call("read_console_messages", { tabId, pattern: "plainlog|warnlog|boom" })).txt;
  check("console captures log, warn, error", ["plainlog", "warn: warnlog", "error: boom-error"].every((s) => logs.includes(s)));
  const errs = (await call("read_console_messages", { tabId, onlyErrors: true })).txt;
  check("onlyErrors keeps errors and uncaught exceptions only", errs.includes("boom-error") && errs.includes("uncaught-boom") && !errs.includes("plainlog"));
  check("pattern filter", !(await call("read_console_messages", { tabId, pattern: "^nomatch$" })).txt.includes("boom"));
  await call("read_console_messages", { tabId, clear: true });
  check("console clear", (await call("read_console_messages", { tabId, pattern: "boom" })).txt.includes("no matching"));

  await js(`await Promise.all([1,2,3].map(i => fetch("/net-test-" + i))); fetch("http://127.0.0.1:18445/dead-endpoint").catch(() => {}); "ok"`);
  await sleep(600);
  const net = (await call("read_network_requests", { tabId, urlPattern: "net-test" })).txt;
  check("network captures method, url, status", net.includes("GET http://127.0.0.1:18444/net-test-1 -> 200"), net.split("\n")[0]);
  const lim = (await call("read_network_requests", { tabId, urlPattern: "net-test", limit: 2 })).txt;
  check("network limit", lim.includes("Showing last 2 of 3") && lim.includes("net-test-3") && !lim.includes("net-test-1 "));
  check("failed request marked", (await call("read_network_requests", { tabId, urlPattern: "dead-endpoint" })).txt.includes("FAILED"));
  await call("read_network_requests", { tabId, clear: true });
  check("network clear", (await call("read_network_requests", { tabId, urlPattern: "net-test" })).txt.includes("no matching"));

  section("navigation");
  const armUnsaved = `addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = "unsaved"; }); "armed"`;
  await js(armUnsaved);
  const held = await call("navigate", { tabId, url: PAGE + "?second" });
  check("unsaved-changes prompt: navigation held back, force suggested", held.err && held.txt.includes("force: true") && (await js("location.search")) === "", held.txt.slice(0, 60));
  const nav = await call("navigate", { tabId, url: PAGE + "?second", force: true });
  check("force goes through the prompt", !nav.err && (await js("location.search")) === "?second", nav.txt.slice(0, 60));
  await call("navigate", { tabId, url: "back" });
  check("back", (await js("location.search")) === "");
  await call("navigate", { tabId, url: "forward" });
  check("forward", (await js("location.search")) === "?second");
  check("forward with no history errors", (await call("navigate", { tabId, url: "forward" })).err);
  const stale = await computer({ action: "left_click", ref: btn });
  check("refs from the old page are rejected", stale.err && stale.txt.includes("Unknown ref"));
  const ctx2 = JSON.parse((await call("tabs_context")).txt);
  check("tabs_context shows the tab", ctx2.some((t) => t.tabId === tabId && t.title === "Bridge Test Page" && t.controllable));

  section("error paths");
  const e1 = await call("javascript_tool", { action: "javascript_exec", tabId, text: `throw new Error("page-boom")` });
  check("page exception surfaces", e1.err && e1.txt.includes("page-boom"));
  check("bad javascript_tool action rejected", (await call("javascript_tool", { action: "nope", tabId, text: "1" })).err);
  const fresh = (await call("read_page", { tabId, filter: "interactive" })).txt;
  const both = await computer({ action: "left_click", ref: refIn(fresh, '"Click me"'), coordinate: [1, 1] });
  check("click with ref and coordinate", both.err && both.txt.includes("not both"));
  check("click with neither", (await computer({ action: "left_click" })).err);
  check("type without text", (await computer({ action: "type" })).err);
  check("key without text", (await computer({ action: "key" })).err);
  check("scroll without direction", (await computer({ action: "scroll", coordinate: [5, 5] })).err);
  check("zoom without region", (await computer({ action: "zoom" })).err);
  check("zoom with inverted region", (await computer({ action: "zoom", region: [100, 100, 50, 50] })).err);
  check("unknown action rejected", (await computer({ action: "teleport" })).err);
  check("wait over the 10s cap rejected", (await computer({ action: "wait", duration: 60 })).err);
  check("unknown modifier", (await computer({ action: "left_click", coordinate: [5, 5], modifiers: "hyper" })).err);
  check("unknown tab id", (await call("read_page", { tabId: 999999999 })).err);
  check("tabs_close unknown tab", (await call("tabs_close", { tabId: 999999999 })).err);
  const dead = await call("navigate", { tabId, url: "http://127.0.0.1:18445/" });
  check("unreachable URL reports the network error", dead.err && dead.txt.includes("ERR_CONNECTION_REFUSED"), dead.txt.slice(0, 70));
  check("tab recovers after a failed navigation", !(await call("navigate", { tabId, url: PAGE })).err && (await js("document.title")) === "Bridge Test Page");

  section("multiple sessions");
  const c2 = await mcpClient().init();
  await sleep(800);
  const peerTabs = await c2.call("tabs_context");
  check("second server joins as a peer", c2.log.includes("peer of an existing"));
  check("peer sees the same browser", !peerTabs.err && JSON.parse(peerTabs.txt).some((t) => t.tabId === tabId));
  check("peer can act on the tab", (await c2.call("javascript_tool", { action: "javascript_exec", tabId, text: "1 + 1" })).txt === "2");
  c2.p.kill();

  section("closing");
  await js(armUnsaved);
  const rb = await rect("btn");
  await computer({ action: "left_click", coordinate: [rb.x + 5, rb.y + 5] }); // a user gesture is what arms the prompt
  const closed = await call("tabs_close", { tabId });
  const left = JSON.parse((await call("tabs_context")).txt);
  check("tabs_close goes through an unsaved-changes prompt", !closed.err && !left.some((t) => t.tabId === tabId), closed.txt.slice(0, 80));
  if (!closed.err) tabId = null;
  check("nothing native left open", await noNativeUi());
} catch (e) {
  console.error("\nSUITE ERROR:", e.message);
  fail++;
} finally {
  if (tabId != null) await call("tabs_close", { tabId }).catch(() => {}); // cleanup after a failed run
}
console.log(`\ne2e: ${pass} passed, ${fail} failed`);
http.close(); c.p.kill();
process.exit(fail ? 1 : 0);
