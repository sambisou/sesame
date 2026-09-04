// Test réel de l'extension Chrome « Sésame », de bout en bout : Chrome (le vrai, /Applications) lancé par
// Playwright sur un profil temporaire, extension chargée par le protocole DevTools, pont natif lancé par Chrome
// (messagerie native), serveur Sésame parlant au pont par sa socket — comme en production, mais tout est temporaire :
//   - SESAME_HOME temporaire (socket du pont, sites.json, journal) ; Trousseau : service de test seulement, pour la
//     présence d'un élément (le secret est injecté par `readSecret`, jamais lu par `security -w`) ; aucun dialogue ;
//   - manifeste de messagerie native TEMPORAIRE, sous un nom de test (app.sesamekey.bridge.test), dans le profil
//     temporaire (<user-data-dir>/NativeMessagingHosts : sur macOS, Chrome lit les manifestes utilisateur dans son
//     dossier de données — ~/Library/Application Support/Google/Chrome/NativeMessagingHosts pour le profil habituel —,
//     donc rien n'est écrit dans le vrai dossier de Chrome, ni le manifeste de production app.sesamekey.bridge) ;
//     l'extension de test rejoint ce nom via chrome.storage.local (clé bridgeName, honorée en extension non empaquetée) ;
//   - le pont (bin/sesame-bridge.js + .sh, src/config.js, src/bridge-client.js) est copié dans le dossier temporaire
//     et lancé de là par un lanceur shell qui exporte SESAME_TEST=1, SESAME_HOME et SESAME_NODE : un processus lancé
//     par Chrome relève des permissions de Chrome (macOS TCC), et Chrome n'a pas forcément accès à ~/Downloads ou
//     ~/Documents où vit le dépôt. Le client authentifie ce pont (lsof + ps) : une copie sous SESAME_HOME est acceptée.
// Depuis Chrome 137, le Chrome de marque ignore --load-extension : l'extension est chargée par la commande DevTools
// Extensions.loadUnpacked (drapeau --enable-unsafe-extension-debugging, session au niveau navigateur, lien par tuyau).
// Lancer : npm run test:extension   (SESAME_TEST_HEADED=1 pour voir la fenêtre Chrome)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-ext-"));
process.env.SESAME_HOME = HOME;
process.env.SESAME_KEYCHAIN_SERVICE = "sesame-test-" + process.pid;
delete process.env.SESAME_BROWSER;
// Le pont est ici réellement lancé par Chrome (le vrai, /Applications) : son parent EST un navigateur
// Chromium, l'authentification du pair (src/bridge-client.js) le vérifie sans assouplissement. Le seul
// assouplissement dont ce banc a besoin est sur le CHEMIN du script (copié sous SESAME_HOME plutôt que le
// fichier du dépôt — Chrome n'a pas forcément accès à ~/Downloads ou ~/Documents, voir plus bas) ; le hash
// reste vérifié dans tous les cas. SESAME_TEST=1 est lu dans l'environnement DE CE PROCESSUS (le client),
// jamais d'après ce que le pont dirait de lui-même.
process.env.SESAME_TEST = "1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(ROOT, "extension");
const PORT = 8766;
const LOGIN = `http://127.0.0.1:${PORT}/2fa-page.html`;
const HOST_NAME = "app.sesamekey.bridge.test";
const HEADED = !!process.env.SESAME_TEST_HEADED;
const SECRET = { username: "sam@test.local", password: "bonmotdepasse" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const noLeak = (s, what) => assert.ok(!String(s).includes(SECRET.password) && !String(s).includes(SECRET.username), `secret visible dans ${what}`);
setTimeout(() => { console.error("⏱ délai global dépassé"); cleanup().finally(() => process.exit(2)); }, 300000).unref();

const cfg = await import("../src/config.js");
const kc = await import("../src/keychain.js");
const { readJournal } = await import("../src/journal.js");
const { BRIDGE_SOCK, bridgePing, bridgeRequest, openBridgeSession, bridgeWaitCode, authenticateBridge, BridgeError } = await import("../src/bridge-client.js");
const { login } = await import("../src/login.js");
const EXT_VERSION = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8")).version;

// ---- Banc : la page de connexion à 2 étapes + code, servie en local (127.0.0.1 et ::1 : « localhost » est l'autre hôte du test de navigation). ----
const html = fs.readFileSync(path.join(ROOT, "test/2fa-page.html"));
const handler = (req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); };
const srv = http.createServer(handler);
await new Promise(r => srv.listen(PORT, "127.0.0.1", r));
const srv6 = http.createServer(handler);
await new Promise(r => { srv6.on("error", () => r()); srv6.listen(PORT, "::1", r); });

// ---- Copie du pont dans le dossier temporaire, lanceur temporaire (SESAME_HOME et node figés, SESAME_TEST=1 pour que le lanceur les honore). ----
const STAGE = path.join(HOME, "sesame");
for (const f of ["bin/sesame-bridge.js", "bin/sesame-bridge.sh", "src/config.js", "src/bridge-client.js"]) {
  fs.mkdirSync(path.join(STAGE, path.dirname(f)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), path.join(STAGE, f));
}
const launcher = path.join(HOME, "sesame-bridge-test.sh");
fs.writeFileSync(launcher, `#!/bin/sh
export SESAME_TEST=1
export SESAME_HOME=${JSON.stringify(HOME)}
export SESAME_NODE=${JSON.stringify(process.execPath)}
exec /bin/sh ${JSON.stringify(path.join(STAGE, "bin/sesame-bridge.sh"))} "$@"
`, { mode: 0o755 });
let ctx = null, profile = null, withSecret = false;
const swLog = [];
async function cleanup() {
  try { await ctx?.close(); } catch {}
  for (const s of [srv, srv6]) { try { s.closeAllConnections(); s.close(); } catch {} }
  if (withSecret) { try { kc.deleteSecret("banc"); } catch {} }
  for (const d of [profile, HOME]) { if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } }
}
process.on("SIGINT", () => cleanup().finally(() => process.exit(130)));

const results = [];
try {
  // ---- Chrome de test : profil temporaire, extension chargée par DevTools. ----
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-ext-profile-"));
  ctx = await chromium.launchPersistentContext(profile, {
    channel: "chrome", headless: !HEADED,
    args: ["--enable-unsafe-extension-debugging"],
    ignoreDefaultArgs: ["--disable-extensions"],
  });
  const cdp = await ctx.browser().newBrowserCDPSession();
  const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT_DIR });
  const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  worker.on("console", m => swLog.push(m.text()));
  assert.equal(worker.url().split("/")[2], extId, "ID de l'extension (service worker)");
  assert.match(extId, /^[a-p]{32}$/);

  // Manifeste natif de test : même forme que celui de `sesame install extension`, nom et chemin de test.
  const nmDir = path.join(profile, "NativeMessagingHosts");
  fs.mkdirSync(nmDir, { recursive: true });
  fs.writeFileSync(path.join(nmDir, HOST_NAME + ".json"), JSON.stringify({
    name: HOST_NAME, description: "Sésame bridge (test)", path: launcher, type: "stdio",
    allowed_origins: [`chrome-extension://${extId}/`],
  }, null, 2) + "\n", { mode: 0o600 });
  // L'extension rejoint le pont de test (chrome.storage.onChanged → reconnexion immédiate ; extension non empaquetée).
  await worker.evaluate(name => chrome.storage.local.set({ bridgeName: name }), HOST_NAME);

  // 0) ping → le pont (lancé par Chrome) répond, extension connectée, version de l'extension ; pair authentifié (lsof + ps).
  let ping = null;
  for (let i = 0; i < 100 && !(ping && ping.extension); i++) { await sleep(300); ping = await bridgePing({ timeoutMs: 3000 }); }
  assert.ok(ping && ping.extension, "pont joignable et extension connectée : " + JSON.stringify(ping));
  assert.equal(ping.version, EXT_VERSION);
  assert.equal(fs.statSync(BRIDGE_SOCK).mode & 0o777, 0o600, "socket en 0600");
  assert.equal(fs.realpathSync(ping.script), fs.realpathSync(path.join(STAGE, "bin/sesame-bridge.js")), "le pong annonce le script réellement lancé par Chrome");
  const bridgePid = ping.pid;
  const auth = await authenticateBridge();
  assert.equal(auth.pid, bridgePid, "pair authentifié : pid du pont lancé par Chrome (parent réellement Chromium, sans assouplissement)");
  results.push(`0 ping → extension:true, version ${ping.version}, pont pid ${bridgePid} (authentifié, parent Chromium pid ${auth.ppid}), extension ${extId}`);

  const site = { key: "banc", domain: "127.0.0.1", loginUrl: LOGIN, selectors: {} };
  /** L'onglet du banc ouvert par l'extension (dans le Chrome de test). */
  async function benchPage(prefix = LOGIN, timeoutMs = 40000) {
    const t = Date.now();
    while (Date.now() - t < timeoutMs) {
      const p = ctx.pages().find(x => x.url().startsWith(prefix));
      if (p) return p;
      await sleep(200);
    }
    throw new Error("aucun onglet du banc ouvert par l'extension");
  }
  /** Éléments ajoutés à <html> hors <head>/<body> : l'hôte du bandeau (nom aléatoire, shadow root fermé) est le seul attendu. */
  const extraElements = p => p.evaluate(() => [...document.documentElement.children].filter(e => e !== document.head && e !== document.body).length);
  const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}));
  /** « L'utilisateur » : attend le champ de code, patiente `delayMs` (le temps que l'extension le détecte), tape le code. */
  async function samTypes(code, delayMs, during) {
    const p = await benchPage();
    await p.locator("#otp").waitFor({ state: "visible", timeout: 60000 });
    await sleep(delayMs);
    if (during) await during(p);
    await p.fill("#otp", code); await p.click("#ok");
    return p;
  }
  const has = (steps, prefix) => assert.ok(steps.some(s => s.startsWith(prefix)), `étape « ${prefix} » absente : ${steps.join(" | ")}`);
  const shape = r => assert.deepEqual(Object.keys(r).sort(), ["hint", "id", "needsDomain", "ok", "reason", "secondFactor", "steps", "title", "type", "url"], "forme de « result »");
  const readyShape = r => assert.deepEqual(Object.keys(r).sort(), ["id", "jobId", "ok", "reason", "steps", "type", "url"], "forme de « ready »");
  /** Les deux temps, SUR LA MÊME connexion authentifiée : prepare (onglet + formulaire) puis fill (secret
   *  vers le jobId) — voir openBridgeSession dans src/bridge-client.js. La session est refermée après. */
  async function prepareAndFill(s, secret, opts) {
    const session = await openBridgeSession();
    try {
      const ready = await session.prepare({ site: s });
      readyShape(ready);
      assert.equal(ready.type, "ready"); assert.equal(ready.ok, true, JSON.stringify(ready));
      assert.match(ready.jobId, /^[0-9a-f-]{36}$/);
      const r = await session.fill({ jobId: ready.jobId, ...secret, ...opts });
      return { ready, r };
    } finally {
      session.close();
    }
  }

  // 1) Remplissage complet avec code : nouvel onglet, identifiant → Suivant → mot de passe → Se connecter, code tapé par
  //    l'utilisateur. Pendant l'attente : bandeau (hôte unique, shadow fermé) et badge « 2FA » ; après : plus rien.
  let seenDuringWait = null;
  const [{ ready: rd1, r: r1 }, p1] = await Promise.all([
    prepareAndFill(site, SECRET, { submit: true, waitCode: true, codeTimeoutSec: 30 }),
    samTypes("424242", 2500, async p => { seenDuringWait = { extra: await extraElements(p), badge: await badge() }; }),
  ]);
  shape(r1); noLeak(JSON.stringify(r1), "réponse fill"); noLeak(JSON.stringify(rd1), "réponse ready");
  assert.equal(rd1.url, LOGIN); has(rd1.steps, "page de connexion ouverte dans un nouvel onglet");
  assert.equal(r1.type, "result"); assert.equal(r1.ok, true, JSON.stringify(r1));
  has(r1.steps, "page de connexion ouverte dans un nouvel onglet");
  for (const s of ["identifiant rempli", "étape 1 validée (bouton)", "mot de passe rempli", "formulaire soumis (bouton)", "code demandé par le site", "code saisi par l'utilisateur"]) has(r1.steps, s);
  assert.deepEqual({ pending: r1.secondFactor.pending, kind: r1.secondFactor.kind }, { pending: false, kind: "champ" }, JSON.stringify(r1.secondFactor));
  assert.equal(r1.hint, null); assert.equal(r1.reason, null);
  assert.equal(r1.url, LOGIN); assert.equal(r1.title, "Banc d'essai Sésame");
  assert.ok(await p1.locator("#s4").isVisible(), "page Bienvenue visible");
  assert.deepEqual(seenDuringWait, { extra: 1, badge: "2FA" }, "bandeau et badge pendant l'attente du code");
  assert.equal(await p1.locator("#sesame-banner").count(), 0, "plus d'ancien bandeau à id fixe");
  assert.equal(await extraElements(p1), 0, "bandeau retiré");
  assert.equal(await badge(), "", "badge retiré");
  // Le jobId est consommé : un second fill avec le même est refusé sans rien toucher.
  const reuse = await bridgeRequest({ type: "fill", jobId: rd1.jobId, username: "u-test", password: "p-test", codeTimeoutSec: 10 });
  assert.equal(reuse.ok, false); assert.match(reuse.reason, /préparation/);
  results.push("1 prepare → fill, code saisi → OK : " + r1.steps.join(", ") + " ; bandeau/badge pendant l'attente puis retirés ; jobId consommé");
  await p1.close();

  // 2) Sans 2FA : pas d'attente, pas de hint, secondFactor null.
  const { r: r2 } = await prepareAndFill({ ...site, loginUrl: LOGIN + "?no2fa=1" }, SECRET, { submit: true, waitCode: true, codeTimeoutSec: 30 });
  shape(r2); noLeak(JSON.stringify(r2), "réponse fill (sans 2FA)");
  assert.equal(r2.ok, true, JSON.stringify(r2)); assert.equal(r2.secondFactor, null); assert.equal(r2.hint, null);
  assert.equal(r2.url, LOGIN, "URL sans paramètres");
  const p2 = await benchPage();
  assert.ok(await p2.locator("#s4").isVisible(), "page Bienvenue visible (sans 2FA)");
  results.push("2 sans code → OK : " + r2.steps.join(", "));
  await p2.close();

  // 3) Mauvais mot de passe : le champ reste → hint « refusés », champ vidé, aucune attente.
  const { r: r3 } = await prepareAndFill(site, { username: SECRET.username, password: "faux" }, { submit: true, waitCode: true, codeTimeoutSec: 30 });
  shape(r3); noLeak(JSON.stringify(r3), "réponse fill (mauvais mot de passe)");
  assert.equal(r3.ok, true, JSON.stringify(r3)); assert.match(r3.hint || "", /refusés/); assert.equal(r3.secondFactor, null);
  const p3 = await benchPage();
  assert.ok(await p3.locator("#s2").isVisible(), "formulaire mot de passe toujours là");
  assert.equal(await p3.locator("#pwd").inputValue(), "", "champ mot de passe vidé");
  results.push("3 mauvais mot de passe → hint « refusés », champ vidé");
  await p3.close();

  // 4) Délai dépassé (10 s) puis sesame_wait_code : reprise de l'attente, l'utilisateur tape le code → OK.
  const { r: r4 } = await prepareAndFill(site, SECRET, { submit: true, waitCode: true, codeTimeoutSec: 10 });
  shape(r4); noLeak(JSON.stringify(r4), "réponse fill (délai)");
  assert.equal(r4.ok, false); assert.match(r4.reason, /délai/); assert.equal(r4.secondFactor.pending, true);
  const p4 = await benchPage();
  assert.equal(await extraElements(p4), 0, "bandeau retiré après le délai");
  assert.equal(await badge(), "", "badge retiré après le délai");
  const [w4] = await Promise.all([ bridgeWaitCode({ site, timeoutSec: 25 }), samTypes("424242", 2000) ]);
  shape(w4);
  assert.equal(w4.ok, true, JSON.stringify(w4)); assert.equal(w4.secondFactor.pending, false); has(w4.steps, "code saisi par l'utilisateur");
  assert.ok(await p4.locator("#s4").isVisible());
  assert.equal(await extraElements(p4), 0); assert.equal(await badge(), "");
  results.push(`4 délai 10 s → ${r4.reason.slice(0, 40)}… puis waitCode → OK : ${w4.steps.join(", ")}`);
  await p4.close();

  // 5) La page navigue vers un AUTRE hôte entre l'identifiant et le mot de passe (?hop=1 : « Suivant » envoie sur
  //    localhost) : l'extension abandonne (« onglet parti vers … »), le mot de passe n'est jamais tapé.
  const { r: r5 } = await prepareAndFill({ ...site, loginUrl: LOGIN + "?hop=1" }, SECRET, { submit: true, waitCode: true, codeTimeoutSec: 30 });
  shape(r5); noLeak(JSON.stringify(r5), "réponse fill (navigation hors domaine)");
  assert.equal(r5.ok, false, JSON.stringify(r5)); assert.match(r5.reason, /onglet parti vers http:\/\/localhost:\d+\/2fa-page\.html : remplissage abandonné/);
  assert.equal(r5.needsDomain, false, "page fraîche sans mot de passe : pas d'apprentissage assisté proposé");
  has(r5.steps, "identifiant rempli"); assert.ok(!r5.steps.some(s => s.startsWith("mot de passe")), "mot de passe non tapé : " + r5.steps.join(" | "));
  const p5 = await benchPage(`http://localhost:${PORT}/`);
  assert.equal(new URL(p5.url()).searchParams.get("hopped"), "1");
  assert.equal(await p5.locator("#pwd").inputValue(), "", "aucun mot de passe sur l'autre hôte");
  assert.equal(await p5.locator("#email").inputValue(), "", "page fraîche sur l'autre hôte");
  results.push("5 navigation vers un autre hôte entre identifiant et mot de passe → abandon, rien tapé sur localhost");
  await p5.close();

  // 5b) Fournisseur d'identité séparé (idp=1) : « Suivant » envoie sur localhost, qui affiche DIRECTEMENT le
  //     mot de passe (cas Expedia). Sans extraDomains : apprentissage assisté détecté — needsDomain:true
  //     (l'extension ne renvoie qu'un booléen ; le domaine enregistrable se calcule côté pont, src/login.js,
  //     via siteDomainFor(url) — voir normalizeResult) — rien tapé.
  const { r: r5b } = await prepareAndFill({ ...site, loginUrl: LOGIN + "?idp=1&no2fa=1" }, SECRET, { submit: true, waitCode: true, codeTimeoutSec: 30 });
  shape(r5b); noLeak(JSON.stringify(r5b), "réponse fill (idp sans extraDomains)");
  assert.equal(r5b.ok, false, JSON.stringify(r5b));
  assert.equal(r5b.needsDomain, true, JSON.stringify(r5b));
  has(r5b.steps, "identifiant rempli"); assert.ok(!r5b.steps.some(s => s.startsWith("mot de passe")), "mot de passe non tapé : " + r5b.steps.join(" | "));
  const p5b = await benchPage(`http://localhost:${PORT}/2fa-page.html?step=pwd`);
  assert.equal(await p5b.locator("#pwd").inputValue(), "", "aucun mot de passe tapé sur le nouveau domaine");
  results.push("5b idp sans extraDomains → needsDomain (booléen côté extension), rien tapé");
  await p5b.close();

  // 5c) Même scénario, mais extraDomains:["localhost"] est déjà autorisé (comme après une approbation par
  //     l'utilisateur — voir approveExtraDomain, src/login.js) : le remplissage se poursuit tout seul.
  const { r: r5c } = await prepareAndFill({ ...site, loginUrl: LOGIN + "?idp=1&no2fa=1", extraDomains: ["localhost"] }, SECRET, { submit: true, waitCode: true, codeTimeoutSec: 30 });
  shape(r5c); noLeak(JSON.stringify(r5c), "réponse fill (idp avec extraDomains)");
  assert.equal(r5c.ok, true, JSON.stringify(r5c));
  has(r5c.steps, "mot de passe rempli");
  const p5c = await benchPage(`http://localhost:${PORT}/2fa-page.html?step=pwd`);
  assert.ok(await p5c.locator("#s4").isVisible(), "page Bienvenue visible (idp, extraDomains)");
  results.push("5c idp avec extraDomains:[localhost] → OK : " + r5c.steps.join(", "));
  await p5c.close();

  // 5d) Rendu tardif du mot de passe sur la MÊME page (late=1, cas Yealink) : rempli sans clic intermédiaire
  //     (pas d'« étape 1 validée » : aucun bouton cliqué avant que le mot de passe n'apparaisse).
  const { r: r5d } = await prepareAndFill({ ...site, loginUrl: LOGIN + "?late=1&no2fa=1" }, SECRET, { submit: true, waitCode: true, codeTimeoutSec: 30 });
  shape(r5d); noLeak(JSON.stringify(r5d), "réponse fill (mot de passe tardif)");
  assert.equal(r5d.ok, true, JSON.stringify(r5d));
  assert.ok(!r5d.steps.some(s => s.startsWith("étape 1 validée")), "aucun clic intermédiaire : " + r5d.steps.join(" | "));
  const p5d = await benchPage();
  assert.ok(await p5d.locator("#s4").isVisible(), "page Bienvenue visible (mot de passe tardif)");
  results.push("5d mot de passe tardif (800 ms) → rempli sans clic intermédiaire : " + r5d.steps.join(", "));
  await p5d.close();

  // 6) Refus sans rien toucher : fill avec un jobId inconnu (refusé par l'extension), prepare avec loginUrl http non locale
  //    (refusé par le pont), prepare d'un site sans onglet ni formulaire → ready ok:false.
  const bogus = await bridgeRequest({ type: "fill", jobId: "bogus-bogus-bogus", username: "u-test", password: "p-test", codeTimeoutSec: 10 });
  assert.equal(bogus.ok, false); assert.match(bogus.reason, /préparation/);
  const sessionHttp = await openBridgeSession();
  await assert.rejects(sessionHttp.prepare({ site: { key: "x", domain: "example.org", loginUrl: "http://example.org/login" } }), e => e instanceof BridgeError && /https/.test(e.message));
  sessionHttp.close();
  const sessionNoForm = await openBridgeSession();
  const noForm = await sessionNoForm.prepare({ site: { key: "x", domain: "127.0.0.1", loginUrl: `http://127.0.0.1:${PORT}/plain.html?noform=1` } });
  sessionNoForm.close();
  readyShape(noForm);
  assert.equal(noForm.ok, false); assert.equal(noForm.jobId, null); assert.match(noForm.reason, /Aucun champ/);
  const pn = await benchPage(`http://127.0.0.1:${PORT}/plain.html`); await pn.close();
  results.push("6 fill sans préparation, loginUrl http, page sans formulaire → refus (rien de tapé)");

  // 7) Le chemin complet du serveur : login() (politique always, secret injecté) → prepare → Trousseau → fill. Journal avec channel.
  withSecret = kc.keychainAvailable();
  if (withSecret) {
    cfg.saveSites({ banc: { domain: "127.0.0.1", loginUrl: LOGIN + "?no2fa=1", policy: "always", selectors: {} } });
    kc.setSecret("banc", { username: "x", password: "y-not-the-real-one" }); // présence seulement (hasSecret)
    let readAt = 0;
    const r7 = await login({ site: "banc", caller: "test", readSecret: () => { readAt = Date.now(); return { ...SECRET }; } });
    noLeak(JSON.stringify(r7), "réponse login()");
    assert.equal(r7.ok, true, JSON.stringify(r7)); assert.equal(r7.channel, "extension"); assert.equal(r7.url, LOGIN);
    assert.ok(readAt > 0, "Trousseau lu");
    has(r7.steps, "page de connexion ouverte"); has(r7.steps, "identifiant rempli"); has(r7.steps, "formulaire soumis");
    const j = readJournal({ site: "banc", limit: 20 });
    assert.ok(j.some(e => e.action === "login" && e.result === "réussi" && e.channel === "extension" && e.caller === "test"), JSON.stringify(j));
    noLeak(fs.readFileSync(cfg.JOURNAL_FILE, "utf8"), "journal");
    const p7 = await benchPage();
    assert.ok(await p7.locator("#s4").isVisible());
    await p7.close();
    results.push("7 login() par le serveur → prepare, Trousseau, fill → OK, channel extension, journal");
  }

  const again = await bridgePing({ timeoutMs: 3000 });
  assert.ok(again && again.extension && again.pid === bridgePid, "un seul pont, toujours le même : " + JSON.stringify(again));
  noLeak(swLog.join("\n"), "console du service worker");
  results.push(`8 même pont (pid ${bridgePid}) du début à la fin ; console du service worker sans secret (${swLog.length} lignes)`);
} catch (e) {
  console.error("❌ extension live : " + (e && e.stack || e));
  if (swLog.length) console.error("   console du service worker :\n   " + swLog.slice(-12).join("\n   "));
  await cleanup();
  process.exit(1);
}
await cleanup();
console.log("✅ extension live OK\n  " + results.join("\n  "));
process.exit(0);
