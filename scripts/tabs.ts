import { readFileSync } from "fs";
const [port, path] = readFileSync(`${process.env.HOME}/Library/Application Support/Google/Chrome/DevToolsActivePort`, "utf8").trim().split("\n");
const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
const t = setTimeout(() => { console.log("TIMEOUT waiting (popup not approved?)"); process.exit(1); }, 90000);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string);
  if (m.id !== 1) return;
  const pages = m.result.targetInfos.filter((x: any) => x.type === "page");
  console.log(`${pages.length} tabs`);
  for (const p of pages) console.log(`- ${p.title.slice(0, 70)} | ${p.url.slice(0, 90)}`);
  clearTimeout(t); ws.close(); process.exit(0);
};
ws.onerror = (e: any) => { console.log("WS error", e?.message ?? e); };
ws.onclose = (e: any) => { console.log("closed", e.code, e.reason); };
