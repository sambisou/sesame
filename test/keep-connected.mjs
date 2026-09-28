// Test de l'écran « session déjà ouverte / choix de compte » (ex. Orange keep-connected) contre une page
// locale, en Chromium headless de Playwright-core (PAS le Chrome Sésame). Aucun Trousseau, aucune interaction
// utilisateur, aucun réseau externe.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import assert from "node:assert/strict"; import { fileURLToPath } from "node:url";
process.env.SESAME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-kc-"));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "test/keep-connected-page.html"));
const handler = (req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); };
const srv = http.createServer(handler);
await new Promise((resolve, reject) => { srv.on("error", reject); srv.listen(0, "127.0.0.1", resolve); });
const port = srv.address().port;
setTimeout(() => { console.error("⏱ délai global dépassé"); process.exit(2); }, 25000);

const { chromium } = await import("playwright-core");
const { fillLogin } = await import("../src/browser.js");

const base = `http://127.0.0.1:${port}/keep-connected-page.html`;
const site = { key: "banc", domain: "127.0.0.1", loginUrl: base, policy: "always", selectors: {} };
const secret = { username: "sam@test.local", password: "bonmotdepasse" };

const browser = await chromium.launch({ headless: true });
const steps = [];

// 1) Compte qui correspond, affiché en clair : « Continuer avec ce compte » cliqué → succès alreadySignedIn,
//    et jamais le lien de déconnexion.
{
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const r = await fillLogin(page, site, secret, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.alreadySignedIn, true, JSON.stringify(r));
  assert.ok(r.steps.some(s => s.includes("session déjà ouverte") && s.includes("Continuer avec ce compte")), r.steps.join(" | "));
  assert.ok(await page.locator("#s4").isVisible(), "page Bienvenue visible (compte qui correspond)");
  assert.equal(await page.locator("#logged-out").count(), 0, "le lien de déconnexion n'a jamais été cliqué");
  steps.push("1 compte qui correspond (en clair) → alreadySignedIn : " + r.steps.join(", "));
  await page.close();
}

// 1bis) Même compte, mais affiché masqué (s***@test.local) : même résultat, via la comparaison par préfixe
//       + domaine (accountMatches), pas une simple recherche exacte.
{
  const page = await browser.newPage();
  await page.goto(base + "?account=" + encodeURIComponent("s***@test.local"), { waitUntil: "domcontentloaded" });
  const r = await fillLogin(page, site, secret, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.alreadySignedIn, true, JSON.stringify(r));
  assert.ok(await page.locator("#s4").isVisible(), "page Bienvenue visible (compte masqué qui correspond)");
  steps.push("1bis compte masqué qui correspond (s***@test.local) → alreadySignedIn");
  await page.close();
}

// 2) Compte différent affiché : « Changer de compte » cliqué → formulaire classique en deux temps (e-mail,
//    Suivant, mot de passe) rempli et soumis. Jamais alreadySignedIn : le mot de passe est bien tapé.
{
  const page = await browser.newPage();
  await page.goto(base + "?account=" + encodeURIComponent("autre@ailleurs.fr"), { waitUntil: "domcontentloaded" });
  const r = await fillLogin(page, site, secret, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.alreadySignedIn, undefined, JSON.stringify(r));
  assert.ok(r.steps.some(s => s.includes("session déjà ouverte") && s.includes("Changer de compte")), r.steps.join(" | "));
  assert.ok(r.steps.some(s => s.startsWith("identifiant rempli")), r.steps.join(" | "));
  assert.ok(r.steps.some(s => s.startsWith("mot de passe rempli")), r.steps.join(" | "));
  assert.ok(r.steps.some(s => s.startsWith("formulaire soumis")), r.steps.join(" | "));
  assert.ok(await page.locator("#s4").isVisible(), "page Bienvenue visible (compte différent, formulaire en 2 temps)");
  steps.push("2 compte différent → Changer de compte → formulaire en 2 temps rempli et soumis : " + r.steps.join(", "));
  await page.close();
}

// 3) Page classique, sans écran « déjà connecté » : comportement inchangé, formulaire en deux temps rempli
//    directement, sans aucune mention de « session déjà ouverte ».
{
  const page = await browser.newPage();
  await page.goto(base + "?classic=1", { waitUntil: "domcontentloaded" });
  const r = await fillLogin(page, site, secret, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.alreadySignedIn, undefined, JSON.stringify(r));
  assert.ok(!r.steps.some(s => s.includes("session déjà ouverte")), r.steps.join(" | "));
  assert.ok(r.steps.some(s => s.startsWith("identifiant rempli")), r.steps.join(" | "));
  assert.ok(r.steps.some(s => s.startsWith("mot de passe rempli")), r.steps.join(" | "));
  assert.ok(await page.locator("#s4").isVisible(), "page Bienvenue visible (page classique)");
  steps.push("3 page classique inchangée : " + r.steps.join(", "));
  await page.close();
}

await browser.close();
srv.closeAllConnections(); srv.close();
console.log("✅ keep-connected OK\n  " + steps.join("\n  "));
process.exit(0);
