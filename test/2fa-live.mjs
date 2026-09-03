// Test réel du 2e facteur contre le Chrome Sésame (port 9222) avec une page locale. Aucun Trousseau.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import assert from "node:assert/strict"; import { fileURLToPath } from "node:url";
process.env.SESAME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-2fa-"));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "test/2fa-page.html"));
const srv = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
await new Promise(r => srv.listen(8765, "127.0.0.1", r));
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
await typist.close(); await b.close(); srv.closeAllConnections(); srv.close();
console.log("✅ 2FA live OK\n  " + steps.join("\n  ")); process.exit(0);
