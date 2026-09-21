// Connection-layer tests. No Chrome needed: fake extensions (plain WebSocket
// clients sending the extension's Origin) talk to real server processes on a
// separate port, so this never touches a live setup on the default port.
import { spawn } from "child_process";
import { createRequire } from "module";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const WebSocket = require("ws");
const PORT = 18555;
const URL_ = `ws://127.0.0.1:${PORT}`;
const EXT_ORIGIN = "chrome-extension://epjnmpnkphfbonblfmfeokijfhmjcfne";
const SERVER = new URL("../server/index.js", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (label, ok, info = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${info ? "  -- " + info : ""}`); };

class McpClient {
  constructor() {
    this.log = "";
    this.p = spawn(process.execPath, [SERVER], { env: { ...process.env, BRIDGE_PORT: String(PORT) } });
    this.p.stderr.on("data", (d) => (this.log += d));
    this.buf = ""; this.waiters = new Map(); this.nextId = 0;
    this.p.stdout.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        try { const m = JSON.parse(l); this.waiters.get(m.id)?.(m); } catch {}
      }
    });
  }
  rpc(method, params) {
    return new Promise((res) => { const id = ++this.nextId; this.waiters.set(id, res); this.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  }
  async init() {
    await this.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "relay-test", version: "0" } });
    this.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await sleep(500);
    return this;
  }
  tabsContext() { return this.tool("tabs_context"); }
  async tool(name, args = {}) {
    const t0 = Date.now();
    const r = await this.rpc("tools/call", { name, arguments: args });
    const txt = r.result?.content?.[0]?.text ?? "";
    const all = (r.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    return { txt, all, err: !!r.result?.isError, ms: Date.now() - t0 };
  }
  kill() { this.p.kill(); }
}

class FakeExt {
  constructor(name, { reconnect = false } = {}) { this.name = name; this.reconnect = reconnect; this.answer = true; this.closeOnRequest = false; this.connected = false; }
  connect() {
    this.ws = new WebSocket(URL_, { origin: EXT_ORIGIN });
    this.ws.on("open", () => (this.connected = true));
    this.ws.on("error", () => {});
    this.ws.on("close", () => { this.connected = false; if (this.reconnect) setTimeout(() => this.connect(), 300); });
    this.ws.on("message", (data) => {
      const m = JSON.parse(data);
      if (this.closeOnRequest) return this.ws.close();
      if (!this.answer) return;
      if (this.silentOn === m.type) return;
      if (m.type === "cdp" && this.cdpReply) return this.ws.send(JSON.stringify({ id: m.id, result: this.cdpReply(m) }));
      if (m.type === "version" && !this.version) return this.ws.send(JSON.stringify({ id: m.id, error: "unknown message type version" })); // like a pre-0.6 extension
      const result = m.type === "tabs.list" ? [{ tabId: 1, title: this.name, url: `https://fake/${this.name}`, active: true }] : m.type === "version" ? { version: this.version } : { ok: true };
      this.ws.send(JSON.stringify({ id: m.id, result }));
    });
    return this;
  }
  async ready() { for (let i = 0; i < 50 && !this.connected; i++) await sleep(100); return this; }
  activate() { this.ws.send('{"type":"activate"}'); }
  close() { this.reconnect = false; this.ws.close(); }
}

const rejected = (opts) => new Promise((res) => {
  const ws = new WebSocket(URL_, opts);
  ws.on("open", () => (ws.close(), res(false)));
  ws.on("error", () => res(true));
  ws.on("unexpected-response", () => res(true));
});
const activeName = async (client) => { const r = await client.tabsContext(); try { return JSON.parse(r.txt)[0].title; } catch { return "ERR: " + r.txt.slice(0, 80); } };

const a = await new McpClient().init();
let b, one, two, three;
try {
  check("first server becomes primary", a.log.includes("primary"));

  const none = await a.tabsContext();
  check("no extension: clear error after a short wait", none.err && none.txt.includes("not connected") && none.ms < 8000, `${none.ms}ms`);

  check("web page origin rejected", await rejected({ origin: "https://evil.example" }));
  check("other extension origin rejected", await rejected({ origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
  check("no origin, no peer header rejected", await rejected({}));

  one = await new FakeExt("one").connect().ready();
  check("extension connects, primary reaches it", (await activeName(a)) === "one");
  check("outdated extension is called out", (await a.tabsContext()).all.includes("older than this server expects"));
  one.version = "99.0.0";
  check("current extension is not", !(await a.tabsContext()).all.includes("older than"));

  one.cdpReply = () => ({ result: { type: "number", value: 2 }, __bridgeNotices: [{ kind: "dialog", dialogType: "confirm", message: "Delete everything?", accepted: false }] });
  const noted = await a.tool("javascript_tool", { action: "javascript_exec", tabId: 1, text: "1 + 1" });
  check("extension notices reach the tool result", noted.txt === "2" && noted.all.includes('confirm dialog ("Delete everything?")') && noted.all.includes("window.confirm"), noted.all.slice(0, 120));
  one.cdpReply = () => ({ result: { type: "number", value: 2 } });
  check("a notice is delivered once", !(await a.tool("javascript_tool", { action: "javascript_exec", tabId: 1, text: "1 + 1" })).all.includes("Note:"));

  one.silentOn = "tabs.close";
  const stuck = await a.tool("tabs_close", { tabId: 1 });
  check("stuck tab close explains itself after 10s", stuck.err && stuck.txt.includes("only a person can dismiss") && stuck.ms < 13000, `${stuck.ms}ms`);
  one.silentOn = null;

  b = await new McpClient().init();
  check("second server joins as peer", b.log.includes("peer of an existing"));
  check("peer is relayed to the extension", (await activeName(b)) === "one");
  one.cdpReply = () => ({ result: { type: "number", value: 2 }, __bridgeNotices: [{ kind: "filechooser" }] });
  check("notices survive the relay to a peer", (await b.tool("javascript_tool", { action: "javascript_exec", tabId: 1, text: "1 + 1" })).all.includes("file picker"));
  one.cdpReply = null;

  two = await new FakeExt("two").connect().ready();
  await sleep(200);
  check("second profile connects: latest is active", (await activeName(a)) === "two");
  one.activate();
  await sleep(200);
  check("icon click (activate) switches profile", (await activeName(a)) === "one");
  one.close();
  await sleep(300);
  check("active profile closes: falls back to the other", (await activeName(a)) === "two");

  two.closeOnRequest = true;
  const dropped = await a.tabsContext();
  check("extension drops mid-call: fails fast, no 30s hang", dropped.err && dropped.txt.includes("disconnected") && dropped.ms < 8000, `${dropped.ms}ms`);

  three = await new FakeExt("three", { reconnect: true }).connect().ready();
  check("extension reconnects after a drop", (await activeName(b)) === "three");

  three.answer = false;
  const inFlight = b.tabsContext();
  await sleep(400);
  a.kill();
  const lost = await inFlight;
  check("primary dies mid-call: peer's call fails fast", lost.err && lost.txt.includes("primary") && lost.ms < 8000, `${lost.ms}ms: ${lost.txt.slice(0, 60)}`);

  three.answer = true;
  let took = null;
  for (let i = 0; i < 40 && took !== "three"; i++) { await sleep(500); took = await activeName(b); }
  check("peer takes over the port, extension follows", took === "three" && b.log.includes("primary"), String(took));
} catch (e) {
  console.error("SUITE ERROR:", e);
  fail++;
} finally {
  for (const x of [one, two, three]) try { x?.close(); } catch {}
  a.kill(); b?.kill();
}
console.log(`\nrelay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
