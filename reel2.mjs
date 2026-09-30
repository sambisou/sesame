import { login } from "./src/login.js";
for (const s of process.argv.slice(2)) {
  const t0 = Date.now();
  const r = await login({ site: s, caller: "test-reel", reason: "vérification des correctifs", waitForCode: false, codeTimeoutSec: 15 });
  const tag = r.ok ? (r.alreadySignedIn ? "déjà connecté" : "rempli") : "échec";
  console.log(`${s.padEnd(12)} ${String(Math.round((Date.now()-t0)/1000)).padStart(3)}s  ${tag.padEnd(14)} ${(r.message||"").slice(0,80)}`);
}
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const pages = list.filter(x => x.type === "page");
const by = {}; for (const p of pages) { const h = (()=>{try{return new URL(p.url).hostname}catch{return p.url.slice(0,25)}})(); by[h]=(by[h]||0)+1; }
console.log(`\nonglets : ${pages.length}`);
for (const [h,n] of Object.entries(by).sort((a,b)=>b[1]-a[1])) console.log(`  ${n>1?"⚠️ ":"  "}${n}× ${h}`);
