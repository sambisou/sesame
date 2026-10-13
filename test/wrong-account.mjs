// Jamais un mot de passe sur la page d'un AUTRE compte, et « arrivé ailleurs » n'est pas un succès.
// Reproduit le piège Booking : session voyageur ouverte, page « Entrez votre mot de passe pour <autre> ».
import http from "node:http"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import assert from "node:assert/strict";
process.env.SESAME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-wa-"));
const PORT = 8849;
let tapeDansLaMauvaisePage = null;

const srv = http.createServer((q, r) => {
  const u = q.url.split("?")[0];
  r.setHeader("content-type", "text/html; charset=utf-8");
  // Page liée au compte VOYAGEUR : un mot de passe, aucun identifiant, et un lien pour changer de compte.
  if (u === "/password-autre") return r.end(`<p>Enter your password for voyageur@exemple.fr</p>
    <input type="password" id="password"><a href="/identifiant">Use another account</a>`);
  // Même page, mais SANS moyen de changer de compte : Sésame doit refuser de taper.
  if (u === "/password-coince") return r.end('<p>Enter your password for voyageur@exemple.fr</p><input type="password" id="password">');
  if (u === "/identifiant") return r.end('<form action="/espace"><input id="username"><input type="password" id="password"><button type="submit">Se connecter</button></form>');
  if (u === "/espace") return r.end('<h1>Extranet partenaire</h1><a href="/logout">Deconnexion</a>');
  if (u === "/voyageur") return r.end('<h1>Site voyageur</h1><a href="/logout">Deconnexion</a>');
  r.end("<p>accueil</p>");
});
await new Promise(r => srv.listen(PORT, "127.0.0.1", r));

const { chromium } = await import("playwright-core");
const { fillLogin } = await import("../src/browser.js");
const base = `http://127.0.0.1:${PORT}`;
const site = extra => ({ key: "extranet", domain: "127.0.0.1", loginUrl: `${base}/`, selectors: {}, ...extra });
const secret = () => ({ username: "partenaire@exemple.fr", password: "motdepasse-partenaire" });
const b = await chromium.launch({ headless: true });
let failed = null;
try {
  // 1. Un autre compte est affiché, un changement de compte est possible : Sésame change, puis remplit.
  {
    const p = await b.newPage(); await p.goto(`${base}/password-autre`);
    const r = await fillLogin(p, site(), secret(), { waitSecondFactor: false });
    assert.equal(r.ok, true, `attendu un succes : ${r.reason}`);
    assert.ok(r.steps.some(x => /autre compte/i.test(x)), `etapes : ${JSON.stringify(r.steps)}`);
    await p.close();
    console.log("  1 autre compte affiché + « use another account » → changement puis remplissage correct");
  }
  // 2. Un autre compte, aucun moyen d'en changer : ÉCHEC, et le champ reste VIDE.
  {
    const p = await b.newPage(); await p.goto(`${base}/password-coince`);
    const r = await fillLogin(p, site(), secret(), { waitSecondFactor: false });
    assert.equal(r.ok, false, "ne doit pas taper le mot de passe sur un autre compte");
    assert.match(r.reason, /autre compte/i, `motif : ${r.reason}`);
    const v = await p.evaluate(() => document.querySelector("#password").value);
    assert.equal(v, "", `le mot de passe NE DOIT PAS avoir ete tape : "${v}"`);
    await p.close();
    console.log("  2 autre compte sans échappatoire → échec, champ mot de passe resté vide");
  }
  // 3. Connexion réussie mais arrivée au mauvais endroit : ce n'est pas un succès.
  {
    const p = await b.newPage(); await p.goto(`${base}/identifiant`);
    const s = site({ successUrl: "/espace" });
    // Le formulaire envoie vers /espace : succès attendu.
    const r = await fillLogin(p, s, secret(), { waitSecondFactor: false });
    assert.equal(r.ok, true, `attendu un succes : ${r.reason}`);
    await p.close();
    const p2 = await b.newPage(); await p2.goto(`${base}/identifiant`);
    const s2 = site({ successUrl: "admin\\.exemple\\.fr" });   // on exige un espace qu'on n'atteindra jamais
    const r2 = await fillLogin(p2, s2, secret(), { waitSecondFactor: false });
    assert.equal(r2.ok, false, "arriver ailleurs que l'espace attendu n'est pas un succes");
    assert.match(r2.reason, /au lieu de l'espace attendu/i, `motif : ${r2.reason}`);
    await p2.close();
    console.log("  3 successUrl : bon espace → succès ; mauvais espace → échec explicite");
  }
} catch (e) { failed = e; } finally {
  await b.close().catch(() => {});
  srv.close();
  fs.rmSync(process.env.SESAME_HOME, { recursive: true, force: true });
}
if (failed) { console.error("❌ wrong-account :", failed.message); process.exit(1); }
console.log("✅ wrong-account OK — jamais de mot de passe sur un autre compte, espace d'arrivée vérifié");
