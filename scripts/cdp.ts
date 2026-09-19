// usage: bun run cdp.ts <urlSubstring> <jsFile>  -> evaluates JS in matching tab, prints result
import { readFileSync } from "fs";
const [, , match, jsFile] = process.argv;
const expr = readFileSync(jsFile, "utf8");
const [port, path] = readFileSync(`${process.env.HOME}/Library/Application Support/Google/Chrome/DevToolsActivePort`, "utf8").trim().split("\n");
const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
let id = 0; const pending = new Map<number, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data as string); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } };
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 110000);
ws.onopen = async () => {
  const t = (await send("Target.getTargets")).result.targetInfos.find((x: any) => x.type === "page" && x.url.includes(match));
  if (!t) { console.log("no tab matching", match); process.exit(1); }
  const { sessionId } = (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).result;
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  console.log(r.result?.exceptionDetails ? JSON.stringify(r.result.exceptionDetails) : (typeof r.result.result.value === "string" ? r.result.result.value : JSON.stringify(r.result.result.value, null, 1)));
  process.exit(0);
};
