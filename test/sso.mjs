// Connexion par fournisseur d'identité : Sésame clique le bouton, ne tape jamais rien chez le fournisseur,
// et un mot de passe refusé répond ÉCHEC (et non « ok » assorti d'un indice).
// Chromium headless + pages locales : aucune vraie connexion, ni Google, ni Chrome Sésame.
import http from "node:http"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import assert from "node:assert/strict";
process.env.SESAME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-sso-"));
const PORT = 8847;
let sessionOuverte = true;   // la session du fournisseur vit déjà dans le navigateur

const srv = http.createServer((q, r) => {
  const u = q.url.split("?")[0];
  r.setHeader("content-type", "text/html; charset=utf-8");
  if (u === "/dashboard") return r.end('<h1>Tableau de bord</h1><a href="/logout">Deconnexion</a>');
  if (u === "/idp") {   // le « fournisseur » : s'il a une session, il renvoie au site ; sinon il demande
    if (sessionOuverte) { r.writeHead(302, { location: "/dashboard" }); return r.end(); }
    return r.end('<h1>Connexion Google</h1><input name="email" id="email"><input type="password" id="password"><button>Suivant</button>');
  }
  if (u === "/sso")       return r.end('<p>This account uses single sign-on (SSO).</p><input type="password" id="password"><button type="submit">Se connecter</button>');
  return r.end('<a href="/idp">Se connecter avec Google</a><form action="/sso"><input id="username"><input type="password" id="password"><button type="submit">Se connecter</button></form>');
});
await new Promise(r => srv.listen(PORT, "127.0.0.1", r));

const { chromium } = await import("playwright-core");
const { fillLogin } = await import("../src/browser.js");
const base = `http://127.0.0.1:${PORT}`;
const site = k => ({ key: k, domain: "127.0.0.1", loginUrl: `${base}/`, selectors: {} });
const secret = { username: "u", password: "p" };
const b = await chromium.launch({ headless: true });
let failed = null;
try {
  // 1. Site déclaré « par Google », session du fournisseur ouverte : un clic suffit, rien n'est tapé.
  {
    const p = await b.newPage(); await p.goto(`${base}/`);
    const s = { ...site("demo"), authProvider: "google" };
    const r = await fillLogin(p, s, { ...secret }, { waitSecondFactor: false });
    assert.equal(r.ok, true, `attendu un succes : ${r.reason}`);
    assert.equal(r.viaProvider, "google");
    assert.ok(r.steps.some(x => /Google.*cliqu/i.test(x)), `etapes : ${JSON.stringify(r.steps)}`);
    await p.close();
    console.log("  1 bouton Google cliqué, session du fournisseur acceptée → succès viaProvider");
  }
  // 2. Même site, mais le fournisseur demande quelque chose : ÉCHEC clair, et RIEN n'est saisi chez lui.
  {
    sessionOuverte = false;
    const p = await b.newPage(); await p.goto(`${base}/`);
    const s = { ...site("demo"), authProvider: "google" };
    const r = await fillLogin(p, s, { ...secret }, { waitSecondFactor: false });
    assert.equal(r.ok, false, "le fournisseur demande une intervention : ce n'est pas un succes");
    assert.equal(r.needsProvider, "google");
    const vals = await p.evaluate(() => [...document.querySelectorAll("input")].map(e => e.value));
    assert.deepEqual(vals, ["", ""], `Sesame ne doit RIEN taper chez le fournisseur : ${JSON.stringify(vals)}`);
    await p.close();
    sessionOuverte = true;
    console.log("  2 fournisseur qui demande un compte → échec explicite, aucun champ rempli chez lui");
  }
  // 3. Compte en authentification unique, mot de passe tenté : ÉCHEC qui nomme la cause, plus jamais « ok ».
  {
    const p = await b.newPage(); await p.goto(`${base}/sso`);
    const r = await fillLogin(p, site("demo"), { ...secret }, { waitSecondFactor: false });
    assert.equal(r.ok, false, "un mot de passe refuse ne doit plus repondre ok");
    assert.match(r.reason, /authentification unique|single sign|fournisseur/i, `motif : ${r.reason}`);
    await p.close();
    console.log("  3 « single sign-on » détecté → échec qui nomme la cause (et non un succès avec indice)");
  }
} catch (e) { failed = e; } finally {
  await b.close().catch(() => {});
  srv.close();
  fs.rmSync(process.env.SESAME_HOME, { recursive: true, force: true });
}
if (failed) { console.error("❌ sso :", failed.message); process.exit(1); }
console.log("✅ sso OK — clic du fournisseur, rien tapé chez lui, mot de passe refusé = échec");
