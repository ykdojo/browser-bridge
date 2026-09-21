// End-to-end test: every tool and computer action, refs AND coordinates,
// against a local instrumented page. Needs Chrome running with the Browser
// Bridge extension loaded; joins any running server as a peer, so it is safe
// to run while other sessions are connected. Run with: npm test (in server/).
import { spawn } from "child_process";
import { createServer } from "http";
import { readFileSync } from "fs";

const html = readFileSync(new URL("./test-page.html", import.meta.url));
const http = createServer((req, res) => res.end(html)).listen(18444, "127.0.0.1");

const p = spawn(process.execPath, [new URL("../server/index.js", import.meta.url).pathname]);
let buf = ""; const waiters = new Map(); let nextId = 0;
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiters.get(m.id)?.(m); } catch {} } });
const rpc = (method, params) => new Promise((res, rej) => { const id = ++nextId; waiters.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => waiters.has(id) && rej(new Error(method + " timeout")), 30000); });
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const c = r.result?.content ?? [];
  return { txt: c.filter((x) => x.type === "text").map((x) => x.text).join(""), img: c.find((x) => x.type === "image"), err: r.result?.isError };
};
let pass = 0, fail = 0;
const check = (label, ok, info = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${info ? "  -- " + info : ""}`); };

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
await new Promise((r) => setTimeout(r, 1200));
const js = async (tabId, code) => (await call("javascript_tool", { action: "javascript_exec", tabId, text: code })).txt;
const events = async (tabId) => JSON.parse(await js(tabId, "JSON.stringify(window.events.splice(0))"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const tabId = JSON.parse((await call("tabs_create", {})).txt).tabId;
  await call("navigate", { tabId, url: "http://127.0.0.1:18444/" });

  // read_page variants
  const all = (await call("read_page", { tabId })).txt;
  check("read_page all", all.includes("Bridge Test Page") && all.includes('button "Click me"'));
  const inter = (await call("read_page", { tabId, filter: "interactive" })).txt;
  check("read_page interactive", inter.includes("button") && !inter.includes("heading"));
  const d0 = (await call("read_page", { tabId, depth: 0 })).txt;
  check("read_page depth=0", d0.includes("RootWebArea") && !d0.includes("Click me"));
  const clipped = (await call("read_page", { tabId, max_chars: 200 })).txt;
  check("read_page max_chars", clipped.includes("truncated") && clipped.length < 400);
  const ref = (label) => inter.split("\n").find((l) => l.includes(label))?.match(/\[(ref_\d+)\]/)?.[1];

  // read_page ref_id focus
  const focus = (await call("read_page", { tabId, ref_id: ref('"Test select"') })).txt;
  check("read_page ref_id", focus.includes("Alpha") && !focus.includes("Click me"));

  // find
  const found = JSON.parse((await call("find", { query: "click me button", tabId })).txt);
  check("find", (found[0] ?? found.matches?.[0])?.name === "Click me");

  // clicks by REF: single, double, right, with modifiers
  await call("computer", { action: "left_click", ref: ref('"Click me"'), tabId });
  await call("computer", { action: "double_click", ref: ref('"Click me"'), tabId });
  await call("computer", { action: "right_click", ref: ref('"Click me"'), tabId });
  await call("computer", { action: "left_click", ref: ref('"Click me"'), tabId, modifiers: "shift+alt" });
  let ev = await events(tabId);
  check("ref left_click", ev.some((e) => e.type === "click" && e.id === "btn" && !e.mods));
  check("ref double_click", ev.some((e) => e.type === "dblclick"));
  check("ref right_click", ev.some((e) => e.type === "contextmenu"));
  check("ref click modifiers", ev.some((e) => e.type === "click" && e.mods === "shift+alt"), JSON.stringify(ev.filter((e) => e.mods)));

  // clicks by COORDINATE (from getBoundingClientRect, like clicking from a screenshot)
  const r0 = JSON.parse(await js(tabId, `JSON.stringify(document.getElementById("btn").getBoundingClientRect())`));
  await call("computer", { action: "left_click", coordinate: [r0.x + r0.width / 2, r0.y + r0.height / 2], tabId });
  ev = await events(tabId);
  check("coordinate left_click", ev.some((e) => e.type === "click" && e.id === "btn"));

  // type into input: click ref to focus, then type, then key
  await call("computer", { action: "left_click", ref: ref('"Test input"'), tabId });
  await call("computer", { action: "type", text: "hello bridge", tabId });
  await call("computer", { action: "key", text: "Backspace", repeat: 6, tabId });
  check("type + key repeat", (await js(tabId, `document.getElementById("txt").value`)) === "hello ");
  await call("computer", { action: "key", text: "cmd+a", tabId });
  await call("computer", { action: "type", text: "replaced", tabId });
  check("cmd+a select-all", (await js(tabId, `document.getElementById("txt").value`)) === "replaced");

  // triple click selects the input text
  await call("computer", { action: "triple_click", ref: ref('"Test input"'), tabId });
  check("triple_click selection", (await js(tabId, `document.getElementById("txt").selectionEnd - document.getElementById("txt").selectionStart`)) === "8");

  // form_input: select by text, contenteditable
  await call("form_input", { ref: ref('"Test select"'), value: "Beta", tabId });
  ev = await events(tabId);
  check("form_input select", (await js(tabId, `document.getElementById("sel").value`)) === "b" && ev.some((e) => e.type === "change"));
  const ceRes = (await call("find", { query: "Editor", tabId })).txt;
  let cref = null;
  try { const ceR = JSON.parse(ceRes); cref = (ceR[0] ?? ceR.matches?.[0])?.ref; } catch {}
  check("find named generic (contenteditable)", !!cref, ceRes.slice(0, 80));
  if (cref) {
    await call("form_input", { ref: cref, value: "edited content", tabId });
    check("form_input contenteditable", (await js(tabId, `document.getElementById("ce").textContent`)) === "edited content");
  } else fail++;

  // hover
  await call("computer", { action: "hover", ref: ref('"hover zone"') ?? "ref_none", tabId }).catch(() => {});
  const hz = JSON.parse(await js(tabId, `JSON.stringify(document.getElementById("hoverzone").getBoundingClientRect())`));
  await call("computer", { action: "hover", coordinate: [hz.x + 20, hz.y + 20], tabId });
  check("hover", (await js(tabId, `document.getElementById("hoverzone").className`)) === "hovered");

  // drag the box 120px right
  const b0 = JSON.parse(await js(tabId, `JSON.stringify(document.getElementById("dragbox").getBoundingClientRect())`));
  await call("computer", { action: "left_click_drag", start_coordinate: [b0.x + 30, b0.y + 30], coordinate: [b0.x + 150, b0.y + 30], tabId });
  const b1 = JSON.parse(await js(tabId, `JSON.stringify(document.getElementById("dragbox").getBoundingClientRect())`));
  check("left_click_drag", Math.abs(b1.x - b0.x - 120) < 5, `moved ${Math.round(b1.x - b0.x)}px`);

  // scroll by coordinate + scroll_to by ref + scroll back up
  await call("computer", { action: "scroll", scroll_direction: "down", scroll_amount: 5, coordinate: [300, 300], tabId });
  await sleep(400); // wheel scrolling settles asynchronously
  const sc1 = Number(await js(tabId, "window.scrollY"));
  check("scroll down", sc1 > 0, `scrollY=${sc1}`);
  const bottomRef = (() => { const m = all.split("\n").find((l) => l.includes("very bottom")); return m?.match(/\[(ref_\d+)\]/)?.[1]; })();
  await call("computer", { action: "scroll_to", ref: bottomRef, tabId });
  check("scroll_to", (await js(tabId, `(r => r.top >= 0 && r.bottom <= innerHeight)(document.getElementById("bottom").getBoundingClientRect())`)) === "true");

  // wait
  const t0 = Date.now();
  await call("computer", { action: "wait", duration: 1, tabId });
  check("wait", Date.now() - t0 >= 950);

  // screenshot + zoom
  const shot = await call("computer", { action: "screenshot", tabId });
  check("screenshot", shot.img?.mimeType === "image/jpeg" && shot.img.data.length > 5000);
  const zoom = await call("computer", { action: "zoom", region: [0, 0, 300, 150], tabId });
  check("zoom", !!zoom.img, zoom.txt?.slice(0, 80));

  // console: onlyErrors and clear
  await js(tabId, `console.log("plainlog"); console.error("boom-error"); undefined`);
  await sleep(400);
  const errs = (await call("read_console_messages", { tabId, onlyErrors: true, pattern: "boom|plain" })).txt;
  check("console onlyErrors", errs.includes("boom-error") && !errs.includes("plainlog"));
  await call("read_console_messages", { tabId, clear: true });
  check("console clear", (await call("read_console_messages", { tabId, pattern: "boom" })).txt.includes("no matching"));

  // network: limit and clear
  await js(tabId, `await Promise.all([1,2,3].map(i => fetch("/net-test-" + i).catch(()=>{}))); "ok"`);
  await sleep(500);
  const lim = (await call("read_network_requests", { tabId, urlPattern: "net-test", limit: 2 })).txt;
  check("network limit", lim.includes("Showing last 2 of 3") && lim.includes("net-test-3"));
  await call("read_network_requests", { tabId, clear: true });
  check("network clear", (await call("read_network_requests", { tabId, urlPattern: "net-test" })).txt.includes("no matching"));

  // navigate: force through beforeunload
  await js(tabId, `window.onbeforeunload = () => "stay!"; "armed"`);
  const nav = await call("navigate", { tabId, url: "http://127.0.0.1:18444/?second", force: true });
  check("navigate force", !nav.err && (await js(tabId, "location.search")) === "?second");
  await call("navigate", { tabId, url: "back" });
  check("navigate back", (await js(tabId, "location.search")) === "");

  // get_page_text max_chars
  const gpt = (await call("get_page_text", { tabId, max_chars: 50 })).txt;
  check("get_page_text max_chars", gpt.includes("truncated"));

  // tabs
  const ctx = JSON.parse((await call("tabs_context", {})).txt);
  check("tabs_context", ctx.some((t) => t.tabId === tabId && t.title === "Bridge Test Page"));
  check("tabs_close", JSON.parse((await call("tabs_close", { tabId })).txt).closed === true);
} catch (e) {
  console.error("SUITE ERROR:", e);
  fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
http.close(); p.kill(); process.exit(fail ? 1 : 0);
