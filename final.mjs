import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: "/Applications/Sésame.app/Contents/MacOS/sesame-mcp", args: ["verif-finale"], env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME } });
const c = new Client({ name: "f", version: "0" }); await c.connect(t);
const sites = JSON.parse((await c.callTool({ name: "sesame_list_sites", arguments: {} })).content[0].text).sites.map(s => s.site);
const skip = new Set(["leclerc", "booking", "creditmutuel", "yealink"]);
let ok = 0, code = 0, ko = 0;
for (const s of sites.filter(x => !skip.has(x))) {
  let o; try { o = JSON.parse((await c.callTool({ name: "sesame_login", arguments: { site: s, reason: "vérification finale 0.6.3", waitForCode: false, codeTimeoutSec: 15 } })).content[0].text); }
  catch (e) { o = { ok: false, message: String(e.message).slice(0, 60) }; }
  const tag = o.ok ? (o.alreadySignedIn ? "déjà connecté" : o.secondFactor?.pending ? "code attendu" : "rempli") : "échec";
  if (o.ok && o.secondFactor?.pending) code++; else if (o.ok) ok++; else ko++;
  console.log(`${s.padEnd(16)} ${tag.padEnd(14)} ${(o.message || "").slice(0, 58)}`);
}
await c.close();
const pages = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).filter(x => x.type === "page");
const by = {}; for (const p of pages) { const h = (()=>{try{return new URL(p.url).hostname}catch{return "?"}})(); by[h]=(by[h]||0)+1; }
console.log(`\n${ok} en ordre, ${code} en attente d'un code, ${ko} en échec`);
console.log(`onglets : ${pages.length} pour ${Object.keys(by).length} hôtes — doublons : ${JSON.stringify(Object.entries(by).filter(([,n])=>n>1))}`);
