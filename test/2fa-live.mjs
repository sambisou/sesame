// Test réel du 2e facteur contre le Chrome Sésame (port 9222) avec une page locale. Aucun Trousseau.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import assert from "node:assert/strict"; import { fileURLToPath } from "node:url";
process.env.SESAME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-2fa-"));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "test/2fa-page.html"));
const handler = (req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); };
const srv = http.createServer(handler);
await new Promise(r => srv.listen(8765, "127.0.0.1", r));
// « localhost » (test idp=1) : selon le système il résout vers ::1 ou 127.0.0.1 (déjà couvert) — on couvre
// aussi ::1, en silence si l'IPv6 est indisponible.
const srv6 = http.createServer(handler);
await new Promise(r => { srv6.on("error", () => r()); srv6.listen(8765, "::1", r); });
setTimeout(() => { console.error("⏱ délai global dépassé"); process.exit(2); }, 120000);
const { connect, openPage, fillLogin, waitForSecondFactor, stopLaunchedChrome } = await import("../src/browser.js");
process.on("exit", () => stopLaunchedChrome());
const site = { key: "banc", domain: "127.0.0.1", loginUrl: "http://127.0.0.1:8765/2fa-page.html", policy: "always", selectors: {} };
const secret = () => ({ username: "sam@test.local", password: "bonmotdepasse" });
const b = await connect();
const typist = await connect(); // « l'utilisateur » qui tape le code, via une 2e connexion CDP
async function samTypes(page, code, delayMs) {
  await new Promise(r => setTimeout(r, delayMs));
  const p = typist.contexts().flatMap(c => c.pages()).find(x => x.url() === page.url());
  await p.fill("#otp", code); await p.click("#ok");
}
const steps = [];
// 1) Flux avec code : l'utilisateur tape 424242 après 4 s → connexion poursuivie.
let page = await openPage(b, site.loginUrl);
let sf = null;
const [r1] = await Promise.all([
  fillLogin(page, site, secret(), { secondFactorTimeoutSec: 30, onSecondFactor: i => { sf = i; } }),
  samTypes(page, "424242", 4000),
]);
assert.equal(r1.ok, true, JSON.stringify(r1));
assert.ok(sf && sf.kind === "champ", "détection champ OTP : " + JSON.stringify(sf));
assert.ok(r1.steps.some(s => s.startsWith("code demandé")), r1.steps.join(" | "));
assert.ok(r1.steps.some(s => s.startsWith("code saisi par l'utilisateur")), r1.steps.join(" | "));
assert.equal(r1.secondFactor.pending, false);
assert.equal(r1.hint, undefined);
assert.ok(await page.locator("#s4").isVisible(), "page Bienvenue visible");
assert.equal(await page.locator("#sesame-banner").count(), 0, "bandeau retiré");
steps.push("1 code saisi → OK : " + r1.steps.join(", "));
await page.close();
// 2) Sans 2FA : pas d'attente, pas de hint (faux positif d'avant corrigé).
page = await openPage(b, site.loginUrl + "?no2fa=1");
const r2 = await fillLogin(page, site, secret(), {});
assert.equal(r2.ok, true); assert.equal(r2.secondFactor, undefined); assert.equal(r2.hint, undefined, r2.hint);
assert.ok(await page.locator("#s4").isVisible());
steps.push("2 sans code → OK : " + r2.steps.join(", "));
await page.close();
// 3) Délai dépassé (5 s), puis reprise de l'attente : l'utilisateur tape le code → done.
page = await openPage(b, site.loginUrl);
const r3 = await fillLogin(page, site, secret(), { secondFactorTimeoutSec: 5 });
assert.equal(r3.ok, false); assert.match(r3.reason, /délai/); assert.equal(r3.secondFactor.pending, true);
const [w] = await Promise.all([ waitForSecondFactor(page, site, { timeoutSec: 20 }), samTypes(page, "424242", 2000) ]);
assert.equal(w.done, true);
assert.ok(await page.locator("#s4").isVisible());
steps.push(`3 délai 5 s → ${r3.reason.slice(0, 40)}… puis reprise → OK en ${w.elapsedSec} s`);
await page.close();
// 4) Mauvais mot de passe : champ mot de passe toujours là → hint « refusés », pas d'attente.
page = await openPage(b, site.loginUrl);
const r4 = await fillLogin(page, site, { username: "sam@test.local", password: "faux" }, { secondFactorTimeoutSec: 5 });
assert.equal(r4.ok, true); assert.match(r4.hint || "", /refusés/); assert.equal(r4.secondFactor, undefined);
steps.push("4 mauvais mot de passe → hint « refusés », aucune attente");
await page.close();
// 5) Fournisseur d'identité séparé (idp=1) : « Suivant » envoie sur localhost pour le mot de passe. Sans
//    extraDomains : apprentissage assisté détecté (needsDomain « localhost »), rien tapé, abandon propre.
page = await openPage(b, site.loginUrl + "?idp=1&no2fa=1");
const r5 = await fillLogin(page, site, secret(), { secondFactorTimeoutSec: 10 });
assert.equal(r5.ok, false, JSON.stringify(r5));
assert.equal(r5.needsDomain, "localhost", JSON.stringify(r5));
assert.ok(r5.steps.some(s => s.startsWith("identifiant rempli")), r5.steps.join(" | "));
assert.ok(!r5.steps.some(s => s.startsWith("mot de passe")), "mot de passe non tapé : " + r5.steps.join(" | "));
steps.push("5 idp sans extraDomains → needsDomain « localhost », rien tapé");
await page.close();
// 6) Même scénario, mais extraDomains:["localhost"] est déjà autorisé (comme après une approbation par
//    l'utilisateur, voir approveExtraDomain côté src/login.js) : le remplissage se poursuit tout seul.
const siteIdp = { ...site, extraDomains: ["localhost"] };
page = await openPage(b, site.loginUrl + "?idp=1&no2fa=1");
const r6 = await fillLogin(page, siteIdp, secret(), { secondFactorTimeoutSec: 10 });
assert.equal(r6.ok, true, JSON.stringify(r6));
assert.ok(r6.steps.some(s => s.startsWith("mot de passe rempli")), r6.steps.join(" | "));
assert.ok(await page.locator("#s4").isVisible(), "page Bienvenue visible (idp, extraDomains)");
steps.push("6 idp avec extraDomains:[localhost] → OK : " + r6.steps.join(", "));
await page.close();
// 7) Rendu tardif du mot de passe sur la MÊME page (late=1, cas Yealink) : rempli sans clic intermédiaire
//    (pas d'« étape 1 validée » dans les steps : aucun bouton cliqué avant le mot de passe).
page = await openPage(b, site.loginUrl + "?late=1&no2fa=1");
const r7 = await fillLogin(page, site, secret(), { secondFactorTimeoutSec: 10 });
assert.equal(r7.ok, true, JSON.stringify(r7));
assert.ok(!r7.steps.some(s => s.startsWith("étape 1 validée")), "aucun clic intermédiaire : " + r7.steps.join(" | "));
assert.ok(await page.locator("#s4").isVisible(), "page Bienvenue visible (late)");
steps.push("7 mot de passe tardif (800 ms) → rempli sans clic intermédiaire : " + r7.steps.join(", "));
await page.close();
await typist.close(); await b.close(); srv.closeAllConnections(); srv.close(); srv6.closeAllConnections(); srv6.close();
console.log("✅ 2FA live OK\n  " + steps.join("\n  ")); process.exit(0);
