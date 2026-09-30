// Un seul onglet par site, quelles que soient les connexions répétées (exigence de Sam, 30/09/2026).
// Chrome de test (port et profil temporaires) + page locale : ne touche ni ~/.sesame ni le Chrome de Sam.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import assert from "node:assert/strict";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-one-tab-"));
process.env.SESAME_HOME = HOME;
process.env.SESAME_KEYCHAIN_SERVICE = "sesame-one-tab-" + process.pid;
process.env.SESAME_CDP_URL = "http://127.0.0.1:9236";
process.env.SESAME_CHROME_HEADLESS = "1";   // aucun Chrome ne doit surgir à l'écran pendant les tests

const PORT = 8843;
// Site d'essai : une fois la session ouverte, /login redirige vers le tableau de bord — comme Cloudflare,
// SiteMinder, Apple… C'est le cas qui faisait repondre a tort « aucun champ identifiant/mot de passe ».
let signedIn = false;
const srv = http.createServer((q, r) => {
  if (q.url.startsWith("/dashboard")) {
    signedIn = true;
    r.setHeader("content-type", "text/html; charset=utf-8");
    return r.end('<h1>Tableau de bord</h1><p>Vous etes connecte.</p><a href="/logout">Deconnexion</a>');
  }
  if (signedIn) { r.writeHead(302, { location: "/dashboard" }); return r.end(); }
  r.setHeader("content-type", "text/html; charset=utf-8");
  r.end('<form method="get" action="/dashboard"><input name="u" id="username"><input name="p" type="password" id="password"><button type="submit">Se connecter</button></form>');
});
await new Promise(r => srv.listen(PORT, "127.0.0.1", r));

const cfg = await import("../src/config.js");
cfg.saveSites({ demo: { domain: "127.0.0.1", loginUrl: `http://127.0.0.1:${PORT}/login`, policy: "always" } });
const kc = await import("../src/keychain.js");
kc.setSecret("demo", { username: "u", password: "p" });

const { connect, allPages, openPage, claimSiteTab, stopLaunchedChrome } = await import("../src/browser.js");
const { login } = await import("../src/login.js");
const { getSite } = cfg;

let failed = null;
try {
  // Trois connexions d'affilée : le site doit garder UN onglet, dans UNE fenêtre.
  const results = [];
  for (let i = 1; i <= 3; i++) {
    const r = await login({ site: "demo", caller: "test", waitForCode: false });
    results.push(r);
    assert.equal(r.ok, true, `connexion ${i} : ${r.message}`);
    const b = await connect();
    const tabs = allPages(b).filter(p => /127\.0\.0\.1:8843/.test(p.url()));
    const windows = new Set();
    for (const p of tabs) {
      try { const s = await p.context().newCDPSession(p); windows.add((await s.send("Browser.getWindowForTarget")).windowId); await s.detach().catch(() => {}); } catch {}
    }
    await b.close();
    assert.equal(tabs.length, 1, `apres ${i} connexion(s) : ${tabs.length} onglet(s) du site au lieu d'un seul`);
    assert.equal(windows.size, 1, `apres ${i} connexion(s) : ${windows.size} fenetres au lieu d'une`);
  }
  console.log("  1 trois connexions d'affilee -> 1 onglet, 1 fenetre");

  // Session deja ouverte : succes explicite, jamais « aucun champ identifiant/mot de passe visible ».
  assert.equal(results[0].alreadySignedIn, undefined, "la 1re connexion remplit bien le formulaire");
  for (const i of [1, 2]) {
    assert.equal(results[i].alreadySignedIn, true, `connexion ${i + 1} : session deja ouverte non reconnue (${results[i].message})`);
  }
  console.log("  2 session deja ouverte (redirection vers le tableau de bord) -> succes « deja connecte »");

  // Des doublons deja presents (heritage des versions precedentes) sont fermes, pas ignores.
  {
    const b = await connect();
    for (let i = 0; i < 3; i++) await openPage(b, `http://127.0.0.1:${PORT}/dashboard?doublon=${i}`);
    const before = allPages(b).filter(p => /127\.0\.0\.1:8843/.test(p.url())).length;
    assert.ok(before >= 4, `doublons non crees (${before})`);
    const kept = await claimSiteTab(b, getSite("demo"));
    const after = allPages(b).filter(p => !p.isClosed() && /127\.0\.0\.1:8843/.test(p.url()));
    assert.ok(kept && !kept.isClosed(), "claimSiteTab doit garder un onglet");
    assert.equal(after.length, 1, `${after.length} onglet(s) restants au lieu d'un seul`);
    await b.close();
    console.log(`  3 ${before} onglets du meme site -> 1 seul conserve, les autres fermes`);
  }
} catch (e) {
  failed = e;
} finally {
  try { kc.deleteSecret("demo"); } catch {}
  stopLaunchedChrome();
  srv.close();
  await new Promise(r => setTimeout(r, 1200));
  fs.rmSync(HOME, { recursive: true, force: true });
}
if (failed) { console.error("❌ one-tab :", failed.message); process.exit(1); }
console.log("✅ one-tab OK — un seul onglet par site, une seule fenetre");
