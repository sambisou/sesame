// Cases « rester connecté / faire confiance à cet appareil » (spécification « connexions robustes », étape 1,
// §5) : cochées juste avant la soumission, jamais une newsletter, des conditions ou une offre ; rien n'est
// coché quand le site déclare rememberMe: false. Chromium headless de Playwright + pages locales : le
// serveur lit les paramètres reçus (soumission GET), c'est lui qui dit ce qui a vraiment été coché.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import assert from "node:assert/strict";

process.env.SESAME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-remember-"));
process.env.SESAME_KEYCHAIN_SERVICE = "sesame-remember-" + process.pid;
process.env.SESAME_CDP_URL = "http://127.0.0.1:9243";   // port dédié (aucun Chrome Sésame n'est lancé ici)
process.env.SESAME_CHROME_HEADLESS = "1";
setTimeout(() => { console.error("⏱ délai global dépassé"); process.exit(2); }, 90000).unref();   // unref : ne retient pas le processus une fois le banc fini

const PORT = 8853;
const base = `http://127.0.0.1:${PORT}`;
let received = null;   // paramètres de la dernière soumission reçue sur /submitted
const FIELDS = '<input id="username" name="username" autocomplete="username"><input id="password" name="password" type="password">';
const srv = http.createServer((q, r) => {
  const url = new URL(q.url, base);
  const u = url.pathname;
  r.setHeader("content-type", "text/html; charset=utf-8");
  if (u === "/submitted") { received = Object.fromEntries(url.searchParams); return r.end('<h1>Tableau de bord</h1><a href="/logout">Déconnexion</a>'); }
  // 1. Libellés par label[for] : une case « Rester connecté » et une case « Recevoir la newsletter ».
  if (u === "/form") return r.end(`<h1>Connexion</h1><form method="get" action="/submitted">${FIELDS}
    <input type="checkbox" id="remember" name="remember"><label for="remember">Rester connecté</label>
    <input type="checkbox" id="newsletter" name="newsletter"><label for="newsletter">Recevoir la newsletter</label>
    <button type="submit">Se connecter</button></form>`);
  // 2. Libellés par label englobant : « Se souvenir de moi » et « J'accepte les conditions générales ».
  if (u === "/form-englobant") return r.end(`<h1>Connexion</h1><form method="get" action="/submitted">${FIELDS}
    <label><input type="checkbox" name="souvenir"> Se souvenir de moi</label>
    <label><input type="checkbox" name="cgu"> J'accepte les conditions générales</label>
    <button type="submit">Se connecter</button></form>`);
  // 3. Libellés par aria-label (anglais) : « Trust this device » et « Receive our offers ».
  if (u === "/form-aria") return r.end(`<h1>Connexion</h1><form method="get" action="/submitted">${FIELDS}
    <input type="checkbox" name="trust" aria-label="Trust this device">
    <input type="checkbox" name="promo" aria-label="Receive our offers and marketing emails">
    <button type="submit">Sign in</button></form>`);
  // 4. Deux étapes : la case « Keep me signed in » n'apparaît qu'à l'étape du mot de passe.
  if (u === "/step-user") return r.end('<h1>Sign in</h1><form method="get" action="/step-pass"><input id="username" name="username" autocomplete="username"><button type="submit">Next</button></form>');
  if (u === "/step-pass") return r.end(`<h1>Sign in</h1><p>${url.searchParams.get("username") || ""}</p><form method="get" action="/submitted">
    <input type="hidden" name="username" value="${url.searchParams.get("username") || ""}"><input id="password" name="password" type="password">
    <input type="checkbox" id="keep" name="keep"><label for="keep">Keep me signed in</label>
    <button type="submit">Sign in</button></form>`);
  // 5. Case déjà cochée : elle ne doit pas être DÉcochée.
  if (u === "/form-cochee") return r.end(`<h1>Connexion</h1><form method="get" action="/submitted">${FIELDS}
    <input type="checkbox" id="remember" name="remember" checked><label for="remember">Rester connecté</label>
    <button type="submit">Se connecter</button></form>`);
  r.end("<p>accueil</p>");
});
await new Promise(r => srv.listen(PORT, "127.0.0.1", r));

const { chromium } = await import("playwright-core");
const { fillLogin } = await import("../src/browser.js");
const site = (p, extra = {}) => ({ key: "banc", domain: "127.0.0.1", loginUrl: base + p, selectors: {}, ...extra });
const secret = () => ({ username: "sam@test.local", password: "bonmotdepasse" });
const b = await chromium.launch({ headless: true });
const STEP_RE = /rester connect/i;   // steps.push("case « rester connecté » cochée (« <libellé> »)")

/** Ouvre `p`, remplit par fillLogin, rend { r, received }. */
async function run(p, extra) {
  received = null;
  const page = await b.newPage(); await page.goto(base + p);
  const r = await fillLogin(page, site(p, extra), secret(), { waitSecondFactor: false });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.close();
  return r;
}

let failed = null;
try {
  // 1. « Rester connecté » cochée, « Recevoir la newsletter » laissée tranquille.
  {
    const r = await run("/form");
    assert.equal(r.ok, true, `attendu un succès : ${r.reason}`);
    assert.ok(received, "le serveur doit avoir reçu la soumission");
    assert.equal(received.remember, "on", `remember attendu : ${JSON.stringify(received)}`);
    assert.equal(received.newsletter, undefined, `la newsletter ne doit pas être cochée : ${JSON.stringify(received)}`);
    assert.equal(received.username, "sam@test.local");
    const step = r.steps.find(s => STEP_RE.test(s));
    assert.ok(step, `étape « rester connecté » attendue : ${JSON.stringify(r.steps)}`);
    assert.match(step, /Rester connecté/, `l'étape nomme le libellé coché : ${step}`);
    console.log("  1 « Rester connecté » cochée (remember=on), « Recevoir la newsletter » non cochée");
  }
  // 2. rememberMe: false → rien coché, aucune étape.
  {
    const r = await run("/form", { rememberMe: false });
    assert.equal(r.ok, true, `attendu un succès : ${r.reason}`);
    assert.equal(received.remember, undefined, `rememberMe: false → rien coché : ${JSON.stringify(received)}`);
    assert.equal(received.newsletter, undefined);
    assert.ok(!r.steps.some(s => STEP_RE.test(s)), `aucune étape « rester connecté » attendue : ${JSON.stringify(r.steps)}`);
    console.log("  2 rememberMe: false → aucune case cochée");
  }
  // 3. Label englobant : « Se souvenir de moi » cochée, pas les conditions générales.
  {
    const r = await run("/form-englobant");
    assert.equal(r.ok, true, `attendu un succès : ${r.reason}`);
    assert.equal(received.souvenir, "on", `souvenir attendu : ${JSON.stringify(received)}`);
    assert.equal(received.cgu, undefined, `les conditions ne doivent jamais être acceptées par Sésame : ${JSON.stringify(received)}`);
    console.log("  3 label englobant : « Se souvenir de moi » cochée, « J'accepte les conditions » non");
  }
  // 4. aria-label : « Trust this device » cochée, pas les offres.
  {
    const r = await run("/form-aria");
    assert.equal(r.ok, true, `attendu un succès : ${r.reason}`);
    assert.equal(received.trust, "on", `trust attendu : ${JSON.stringify(received)}`);
    assert.equal(received.promo, undefined, `les offres ne doivent pas être cochées : ${JSON.stringify(received)}`);
    console.log("  4 aria-label : « Trust this device » cochée, « Receive our offers » non");
  }
  // 5. Deux étapes : la case de l'étape mot de passe est cochée avant cette soumission-là.
  {
    const r = await run("/step-user");
    assert.equal(r.ok, true, `attendu un succès : ${r.reason}`);
    assert.equal(received.keep, "on", `keep attendu à l'étape mot de passe : ${JSON.stringify(received)}`);
    assert.equal(received.username, "sam@test.local");
    console.log("  5 deux étapes : « Keep me signed in » cochée à l'étape du mot de passe");
  }
  // 6. Case déjà cochée : conservée (jamais décochée), une seule étape au plus.
  {
    const r = await run("/form-cochee");
    assert.equal(r.ok, true, `attendu un succès : ${r.reason}`);
    assert.equal(received.remember, "on", `une case déjà cochée doit le rester : ${JSON.stringify(received)}`);
    assert.ok(r.steps.filter(s => STEP_RE.test(s)).length <= 1, `au plus une étape : ${JSON.stringify(r.steps)}`);
    console.log("  6 case déjà cochée → conservée");
  }
} catch (e) { failed = e; } finally {
  await b.close().catch(() => {});
  srv.closeAllConnections?.(); srv.close();
  fs.rmSync(process.env.SESAME_HOME, { recursive: true, force: true });
}
if (failed) { console.error("❌ remember-me :", failed.message); process.exit(1); }
console.log("✅ remember-me OK — « rester connecté » coché, newsletter/conditions/offres jamais, rien si rememberMe: false");
