// Reload the unpacked extension from disk, without visiting chrome://extensions.
//   node scripts/reload-extension.mjs           reload once
//   node scripts/reload-extension.mjs --watch   reload whenever extension/ changes
// Talks to the extension through a running Browser Bridge server, or starts one
// for the duration if no agent session has one up.
import { spawn } from "child_process";
import { watch } from "fs";
import { createRequire } from "module";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const WebSocket = require("ws");
const PORT = Number(process.env.BRIDGE_PORT ?? 17333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(msg) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { "x-bridge-peer": "1" } });
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, ...msg })));
    ws.on("message", (d) => { const m = JSON.parse(d); ws.close(); m.error ? rej(new Error(m.error)) : res(m.result); });
    ws.on("error", rej);
  });
}
const version = () => send({ type: "version" }).then((r) => r.version, () => null);

let own = null;
if (!(await send({ type: "ping" }).then(() => true, (e) => e.code !== "ECONNREFUSED"))) {
  own = spawn(process.execPath, [new URL("../server/index.js", import.meta.url).pathname], { stdio: ["pipe", "ignore", "ignore"] });
  process.on("exit", () => own.kill());
}

async function reload() {
  let v = null;
  for (let i = 0; i < 40 && !v; i++) { v = await version(); if (!v) await sleep(1000); }
  if (!v) throw new Error("extension not reachable: is Chrome running with Browser Bridge loaded (version 0.6.0 or newer)?");
  await send({ type: "reload" }).catch(() => {});
  await sleep(1500);
  v = null;
  for (let i = 0; i < 40 && !v; i++) { v = await version(); if (!v) await sleep(500); }
  console.log(v ? `reloaded: extension ${v}` : "reload sent, but the extension has not reconnected yet");
}

await reload();
if (!process.argv.includes("--watch")) process.exit(0);

console.log("watching extension/ for changes (ctrl+c to stop)");
let timer = null;
watch(new URL("../extension/", import.meta.url).pathname, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => reload().catch((e) => console.error(e.message)), 300);
});
