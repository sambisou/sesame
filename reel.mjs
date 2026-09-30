import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const sites = process.argv.slice(2);
const t = new StdioClientTransport({ command: "/Applications/Sésame.app/Contents/MacOS/sesame-mcp", args: ["test-reel"], env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME } });
const c = new Client({ name: "reel", version: "0" }); await c.connect(t);
for (const s of sites) {
  const t0 = Date.now();
  let o; try { o = JSON.parse((await c.callTool({ name: "sesame_login", arguments: { site: s, reason: "vérification après correctifs (un onglet par site)", waitForCode: false, codeTimeoutSec: 15 } })).content[0].text); }
  catch (e) { o = { ok: false, message: String(e.message).slice(0, 90) }; }
  const tag = o.ok ? (o.alreadySignedIn ? "déjà connecté" : "rempli") : "échec";
  console.log(`${s.padEnd(14)} ${String(Math.round((Date.now()-t0)/1000)).padStart(3)}s  ${tag.padEnd(14)} ${(o.message || "").slice(0, 85)}`);
}
await c.close();
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const pages = list.filter(x => x.type === "page");
const byHost = {};
for (const p of pages) { const h = (() => { try { return new URL(p.url).hostname; } catch { return p.url.slice(0, 30); } })(); byHost[h] = (byHost[h] || 0) + 1; }
console.log(`\nonglets ouverts : ${pages.length}`);
for (const [h, n] of Object.entries(byHost).sort((a,b)=>b[1]-a[1])) console.log(`  ${n > 1 ? "⚠️ " : "  "}${n}× ${h}`);
