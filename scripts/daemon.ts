// Holds ONE CDP connection open; POST JS to the unix socket: /eval?tab=<urlSubstring>
import { readFileSync, existsSync, unlinkSync } from "fs";
const SOCK = "cdp.sock";
if (existsSync(SOCK)) unlinkSync(SOCK);
const [port, path] = readFileSync(`${process.env.HOME}/Library/Application Support/Google/Chrome/DevToolsActivePort`, "utf8").trim().split("\n");
const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
let id = 0; const pending = new Map<number, (v: any) => void>(); const sessions = new Map<string, string>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data as string); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } };
ws.onclose = () => { console.log("ws closed"); process.exit(0); };
await new Promise((r) => (ws.onopen = r));
console.log("connected");
Bun.serve({ unix: SOCK, idleTimeout: 0, async fetch(req) {
  const u = new URL(req.url); const body = await req.text();
  if (u.pathname === "/tabs") { const t = (await send("Target.getTargets")).result.targetInfos.filter((x: any) => x.type === "page"); return Response.json(t.map((x: any) => ({ title: x.title, url: x.url }))); }
  if (u.pathname === "/cdp") { const { method, params, tab } = JSON.parse(body); return Response.json(await send(method, params, tab ? await sess(tab) : undefined)); }
  const r = await send("Runtime.evaluate", { expression: body, awaitPromise: true, returnByValue: true }, await sess(u.searchParams.get("tab") ?? ""));
  const v = r.result?.exceptionDetails ? { error: r.result.exceptionDetails } : r.result?.result?.value;
  return new Response(typeof v === "string" ? v : JSON.stringify(v, null, 1));
}});
async function sess(match: string) {
  const t = (await send("Target.getTargets")).result.targetInfos.find((x: any) => x.type === "page" && x.url.includes(match));
  if (!t) throw new Error("no tab " + match);
  if (!sessions.has(t.targetId)) sessions.set(t.targetId, (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).result.sessionId);
  return sessions.get(t.targetId)!;
}
