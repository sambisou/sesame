// Test réel du problème du 28/09/2026 : un onglet figé (boucle JS bloquante, vu avec Crédit Mutuel et
// Sonnette) bloque `chromium.connectOverCDP` sur TOUTES les cibles, même si Chrome répond bien sur le port.
// connect() doit le détecter (sondage WebSocket direct), le fermer, réessayer, et rendre un navigateur
// utilisable — sans jamais toucher au vrai Chrome Sésame de l'utilisateur : port et profil dédiés à ce test.
// Lancer : npm run test:chrome (inclus aussi dans `npm run check`, ~20 s, sans interaction).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.SESAME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-frozen-"));
process.env.SESAME_CDP_URL = "http://127.0.0.1:9231"; // jamais 9222 (le vrai Chrome Sésame) : port dédié au banc
process.env.SESAME_CHROME_HEADLESS = "1";   // aucun Chrome ne doit surgir à l'écran pendant les tests
setTimeout(() => { console.error("⏱ délai global dépassé"); process.exit(2); }, 40000);

const { launchChrome, stopLaunchedChrome, connect, listPageTargets } = await import("../src/browser.js");
const { CDP_URL } = await import("../src/config.js");
// Jamais appelé ailleurs qu'ici et dans les autres bancs d'essai : stopLaunchedChrome n'arrête QUE le Chrome
// lancé par ce processus (pid mémorisé par launchChrome), jamais le Chrome habituel de l'utilisateur.
process.on("exit", () => stopLaunchedChrome());

const up = await launchChrome();
assert.ok(up, "le Chrome de test (profil et port dédiés) doit répondre après lancement");

// Gèle un nouvel onglet : cible DevTools créée, puis une boucle infinie y est évaluée SANS attendre la
// réponse (elle ne viendra jamais) — c'est exactement ce qui rend le thread renderer, et donc sa session
// DevTools, injoignable.
const created = await fetch(`${CDP_URL}/json/new?about:blank`, { method: "PUT" }).then(r => r.json());
await new Promise(resolve => {
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  ws.onopen = () => {
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "while(true){}" } }));
    // La boucle bloque le thread avant toute réponse : pas la peine d'attendre, on ferme NOTRE bout tout de
    // suite (sinon la connexion WebSocket ouverte garderait le processus de test en vie jusqu'au filet 40 s).
    setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 500);
  };
  ws.onerror = () => resolve();
});

const before = await listPageTargets();
assert.ok(before.length >= 2, `au moins 2 onglets avant connect() (trouvé ${before.length})`);
assert.ok(before.some(t => t.id === created.id), "l'onglet figé doit apparaître dans /json/list");

const events = [];
const t0 = Date.now();
const browser = await connect({ onEvent: e => events.push(e) });
const elapsedSec = Math.round((Date.now() - t0) / 1000);
console.log(`connect() a repris la main en ${elapsedSec} s — événements : ${events.map(e => `${e.result}: ${e.detail}`).join(" | ")}`);

assert.ok(events.some(e => /onglet figé fermé/.test(e.detail || "")), "un événement « onglet figé fermé » doit être journalisé : " + JSON.stringify(events));
assert.ok(events.some(e => e.detail?.includes(created.id) || /onglet figé fermé/.test(e.detail || "")), "l'événement doit identifier l'onglet fermé");
// Redémarrage en dernier recours seulement si la fermeture de l'onglet ne suffit pas : ici, elle doit suffire.
assert.ok(!events.some(e => /redémarré/.test(e.detail || "")), "fermer l'onglet figé doit suffire, sans avoir à redémarrer Chrome : " + JSON.stringify(events));

// Le navigateur rendu est bien utilisable : on peut ouvrir un onglet et y naviguer.
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
await page.goto("about:blank");
assert.equal(page.url(), "about:blank");
await page.close();

// La cible figée a bien été fermée (pas seulement ignorée).
const after = await listPageTargets();
assert.ok(!after.some(t => t.id === created.id), "la cible figée doit avoir disparu de /json/list");

await browser.close();
console.log(`✅ chrome-frozen OK — onglet figé détecté et fermé, attache reprise en ${elapsedSec} s, navigateur utilisable`);
process.exit(0);
