// Sonde avant connexion (spécification « connexions robustes », étape 1, §2) : quand la session est déjà
// vivante, Sésame ne ramène plus l'onglet sur la page de connexion, ne lit AUCUN secret et répond
// ok.already_signed_in ; session.probeUrl et deadUrlRe sont honorés ; une page en plein défi (mot de passe,
// code) n'est jamais quittée. Chrome de test headless (port et profil dédiés) + page locale : ne touche ni
// ~/.sesame ni le Chrome de Sam.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import assert from "node:assert/strict";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-probe-"));
process.env.SESAME_HOME = HOME;
process.env.SESAME_KEYCHAIN_SERVICE = "sesame-probe-" + process.pid;
process.env.SESAME_CDP_URL = "http://127.0.0.1:9240";
process.env.SESAME_CHROME_HEADLESS = "1";   // aucun Chrome ne doit surgir à l'écran pendant les tests
setTimeout(() => { console.error("⏱ délai global dépassé"); process.exit(2); }, 180000).unref();   // unref : ne retient pas le processus une fois le banc fini

const PORT = 8850;
const base = `http://127.0.0.1:${PORT}`;
// Site d'essai : une fois la session ouverte (côté serveur), /login redirige vers le tableau de bord.
// Chaque requête est comptée par chemin : c'est ce compteur qui prouve « /login jamais redemandé » et
// « aucune navigation » pendant un défi.
let signedIn = false;
const hits = {};
const hit = p => { hits[p] = (hits[p] || 0) + 1; };
const total = () => Object.values(hits).reduce((a, b) => a + b, 0);
const FORM = '<h1>Connexion</h1><form method="get" action="/dashboard"><input name="u" id="username"><input name="p" type="password" id="password"><button type="submit">Se connecter</button></form>';
const srv = http.createServer((q, r) => {
  const u = q.url.split("?")[0];
  if (u === "/favicon.ico") { r.writeHead(404); return r.end(); }   // demandé par Chrome après chaque page : jamais compté
  hit(u);
  r.setHeader("content-type", "text/html; charset=utf-8");
  if (u === "/dashboard") { signedIn = true; return r.end('<h1>Tableau de bord</h1><p>Vous êtes connecté.</p><a href="/logout">Déconnexion</a>'); }
  // Page interne légère à sonder : vivante (#alive) si connecté, sinon renvoi vers la page de connexion.
  if (u === "/probe-page") {
    if (!signedIn) { r.writeHead(302, { location: "/login" }); return r.end(); }
    return r.end('<h1>Mon espace</h1><div id="alive">Bienvenue</div><a href="/logout">Déconnexion</a>');
  }
  // Étape « code de vérification » : un champ de code, aucun mot de passe, aucun identifiant.
  if (u === "/code") return r.end('<h1>Vérification</h1><p>Saisissez le code de vérification reçu par e-mail.</p><input type="number" name="otp" autocomplete="one-time-code" inputmode="numeric"><button>Valider</button>');
  if (u === "/login") { if (signedIn) { r.writeHead(302, { location: "/dashboard" }); return r.end(); } return r.end(FORM); }
  // Défi anti-robot résiduel sur l'onglet : aucun formulaire, une frame de défi (bframe) bien visible.
  if (u === "/defi") return r.end('<h1>Vérification</h1><iframe src="/recaptcha/api2/bframe?k=abc" width="400" height="580" title="défi"></iframe>');
  if (u === "/recaptcha/api2/bframe") return r.end("<p>Sélectionnez toutes les images contenant un feu.</p>");
  r.end("<p>accueil</p>");
});
await new Promise(r => srv.listen(PORT, "127.0.0.1", r));

const cfg = await import("../src/config.js");
const kc = await import("../src/keychain.js");
const { connect, allPages, claimSiteTab, openPage, probeSession, publicUrl, stopLaunchedChrome } = await import("../src/browser.js");
const { login, probe } = await import("../src/login.js");
const { readJournal } = await import("../src/journal.js");
const { siteState, attemptsToday, checkLock } = await import("../src/state.js");
const { getSite } = cfg;

const setSite = (extra = {}) => cfg.saveSites({ demo: { domain: "127.0.0.1", loginUrl: `${base}/login`, policy: "always", selectors: {}, ...extra } });
setSite();
kc.setSecret("demo", { username: "u", password: "p" });

// Espion : chaque lecture du secret passe par ici.
let secretReads = 0;
const readSecret = () => { secretReads++; return { username: "u", password: "p" }; };

/** Amène l'onglet (unique) du site sur `url`, en l'ouvrant s'il n'existe pas. */
async function tabTo(url) {
  const b = await connect();
  const page = (await claimSiteTab(b, getSite("demo"))) || await openPage(b, url);
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await b.close();
}
/** Ramène l'onglet du site sur about:blank : plus aucun onglet du site. */
async function resetTab() {
  const b = await connect();
  for (const p of allPages(b)) if (!p.isClosed() && p.url().startsWith(base)) await p.goto("about:blank").catch(() => {});
  await b.close();
}

let failed = null;
try {
  // (a) Trois connexions d'affilée : la 1re remplit ; les 2e et 3e trouvent la session vivante par la sonde,
  //     sans relire le secret ni redemander /login.
  {
    const results = [];
    let loginHitsAfterFirst = null;
    for (let i = 1; i <= 3; i++) {
      const r = await login({ site: "demo", caller: "test", waitForCode: false, readSecret });
      results.push(r);
      assert.equal(r.ok, true, `connexion ${i} : ${r.message}`);
      if (i === 1) loginHitsAfterFirst = hits["/login"] || 0;
    }
    assert.ok(loginHitsAfterFirst >= 1, "la 1re connexion doit ouvrir la page de connexion");
    assert.equal(results[0].alreadySignedIn, undefined, "la 1re connexion remplit bien le formulaire");
    assert.equal(results[0].code, "ok.signed_in", `1re connexion : code ${results[0].code}`);
    assert.notEqual(results[0].probe, true, "la 1re connexion n'est pas un succès « par la sonde »");
    for (const i of [1, 2]) {
      const r = results[i];
      assert.equal(r.code, "ok.already_signed_in", `connexion ${i + 1} : code ${r.code} (${r.message})`);
      assert.equal(r.probe, true, `connexion ${i + 1} : probe: true attendu`);
      assert.equal(r.alreadySignedIn, true, `connexion ${i + 1} : alreadySignedIn conservé pour l'ancien appelant`);
      assert.equal(r.outcome, "ok"); assert.equal(r.retry, "never"); assert.equal(r.actor, "none");
      assert.equal(r.confidence, "medium", `connexion ${i + 1} : sans aliveSel, confidence medium (${r.confidence})`);
    }
    assert.equal(secretReads, 1, `le secret doit avoir été lu UNE seule fois en trois connexions (${secretReads})`);
    assert.equal(hits["/login"], loginHitsAfterFirst, `/login redemandé après la 1re connexion (${hits["/login"]} ≠ ${loginHitsAfterFirst})`);
    const j = readJournal({ site: "demo", limit: 100 });
    assert.ok(j.some(e => e.action === "login" && e.result === "réussi" && /sonde/.test(e.detail || "") && /aucun secret/.test(e.detail || "")),
      "le journal doit dire « session vivante (sonde), aucun secret lu »");
    assert.ok(!j.some(e => /retour sur la page de connexion/.test(e.detail || "")), "l'ancien chemin « onglet sans formulaire → page de connexion » ne doit plus être pris");
    const st = siteState("demo");
    assert.equal(st?.state, "alive", `état du site : ${JSON.stringify(st)}`);
    assert.ok(st.lastProbe, "lastProbe attendu dans l'état");
    console.log("  1 (a) 1re connexion remplit ; 2e et 3e → ok.already_signed_in par la sonde, secret lu 1 fois, /login jamais redemandé");
  }

  // (b) session.probeUrl + aliveSel : la sonde va sur la page interne désignée ; confiance haute.
  {
    setSite({ session: { probeUrl: `${base}/probe-page`, aliveSel: "#alive" } });
    const before = hits["/probe-page"] || 0, beforeLogin = hits["/login"];
    const r = await login({ site: "demo", caller: "test", waitForCode: false, readSecret });
    assert.equal(r.ok, true, `connexion : ${r.message}`);
    assert.equal(r.code, "ok.already_signed_in", `code ${r.code}`);
    assert.equal(r.probe, true);
    assert.equal(r.confidence, "high", `aliveSel visible → confidence high (${r.confidence})`);
    assert.ok((hits["/probe-page"] || 0) > before, "la sonde doit avoir demandé session.probeUrl");
    assert.equal(hits["/login"], beforeLogin, "/login ne doit pas être demandé quand la sonde est vivante");
    assert.equal(secretReads, 1, "aucune lecture du secret quand la sonde est vivante");
    if (r.url) assert.match(r.url, /\/probe-page$/, `url rendue : ${r.url}`);
    console.log("  2 (b) session.probeUrl honoré, aliveSel vu → ok.already_signed_in, confidence high");
  }

  // (c) Session expirée côté serveur : probeUrl renvoie vers /login, que deadUrlRe reconnaît → sonde « dead »,
  //     puis connexion normale (secret lu, formulaire rempli).
  {
    signedIn = false;
    setSite({ session: { probeUrl: `${base}/probe-page`, deadUrlRe: "/login$" } });
    const r = await login({ site: "demo", caller: "test", waitForCode: false, readSecret });
    assert.equal(r.ok, true, `connexion : ${r.message}`);
    assert.equal(r.code, "ok.signed_in", `code ${r.code} (${r.message})`);
    assert.notEqual(r.probe, true, "après une sonde « dead », le succès vient du remplissage, pas de la sonde");
    assert.equal(r.alreadySignedIn, undefined);
    assert.equal(r.confidence, "medium", `looksSignedIn sur le tableau de bord → medium (${r.confidence})`);
    assert.equal(secretReads, 2, `le secret doit avoir été relu une fois (${secretReads})`);
    assert.ok(signedIn, "le formulaire doit avoir été soumis (session rouverte côté serveur)");
    const j = readJournal({ site: "demo", limit: 100 });
    assert.ok(j.some(e => e.result === "sonde"), "la sonde doit laisser une trace « sonde » au journal");
    console.log("  3 (c) deadUrlRe reconnaît la redirection vers /login → sonde dead, puis connexion normale");
  }

  // (d) Défi en cours (champ de code, puis champ mot de passe) : la sonde répond « challenge » et ne navigue
  //     pas — pas une seule requête au serveur.
  {
    setSite();
    signedIn = false;
    await tabTo(`${base}/code`);
    await new Promise(r => setTimeout(r, 500));   // laisser finir d'éventuelles requêtes tardives de la page
    {
      const b = await connect();
      const page = await claimSiteTab(b, getSite("demo"));
      assert.ok(page, "l'onglet du site doit exister");
      const before = total();
      const p = await probeSession(b, getSite("demo"));
      assert.equal(p.state, "challenge", `état de la sonde : ${JSON.stringify({ state: p.state, url: p.url, reason: p.reason })}`);
      assert.equal(total(), before, `la sonde a navigué pendant un défi (${total() - before} requête(s))`);
      assert.equal(p.url, publicUrl(page.url()), `url rendue : ${p.url}`);
      assert.match(p.url, /\/code$/);
      assert.ok(p.page && !p.page.isClosed(), "la sonde rend la page du défi");
      await b.close();
    }
    await tabTo(`${base}/login`);   // formulaire identifiant / mot de passe affiché
    await new Promise(r => setTimeout(r, 500));
    {
      const b = await connect();
      const before = total();
      const p = await probeSession(b, getSite("demo"));
      assert.equal(p.state, "challenge", `mot de passe affiché : état ${p.state}`);
      assert.equal(total(), before, "aucune navigation quand un mot de passe est affiché");
      await b.close();
    }
    // Par login() : on reprend sur cette page sans la quitter — /login n'est pas redemandé, le formulaire est rempli.
    const beforeLogin = hits["/login"];
    const r = await login({ site: "demo", caller: "test", waitForCode: false, readSecret });
    assert.equal(r.ok, true, `connexion sur la page en défi : ${r.message}`);
    assert.equal(r.code, "ok.signed_in", `code ${r.code}`);
    assert.equal(hits["/login"], beforeLogin, "la page en défi ne doit pas être rechargée");
    assert.equal(secretReads, 3);
    console.log("  4 (d) champ de code ou mot de passe affiché → challenge, aucune navigation ; login() reprend sur place");
  }

  // (e) probe() seule (op « sonder » de l'atelier) : jamais de secret, verdict + état, ok.already_signed_in ou ok.probed.
  {
    const alive = await probe({ site: "demo", caller: "test" });
    assert.equal(alive.ok, true, `probe : ${alive.message}`);
    assert.equal(alive.state, "alive", `état ${alive.state}`);
    assert.equal(alive.code, "ok.already_signed_in"); assert.equal(alive.outcome, "ok");
    assert.equal(siteState("demo")?.state, "alive");
    signedIn = false;
    await resetTab();
    const beforeLogin = hits["/login"] || 0;
    const dead = await probe({ site: "demo", caller: "test" });
    assert.equal(dead.ok, true, `probe : ${dead.message}`);
    assert.equal(dead.state, "dead", `état ${dead.state}`);
    assert.equal(dead.code, "ok.probed"); assert.equal(dead.outcome, "ok");
    assert.equal(hits["/login"], beforeLogin + 1, "sans onglet, la sonde ouvre la page de connexion (une fois)");
    assert.equal(siteState("demo")?.state, "dead");
    assert.equal(secretReads, 3, "probe() ne lit jamais le secret");
    const j = readJournal({ site: "demo", limit: 100 });
    assert.ok(j.some(e => e.action === "sonde"), "probe() journalise une action « sonde »");
    assert.ok(!j.some(e => e.action === "sonde" && /Trousseau|secret lu|identifiants lus/.test(e.detail || "")), "aucune lecture de secret pour une sonde");
    console.log("  5 (e) probe() : alive → ok.already_signed_in ; dead → ok.probed ; état mis à jour, aucun secret lu");
  }

  // (f) Captcha vu par la SONDE (onglet en plein défi, rien lu, rien soumis) : login() répond fail.captcha avec
  //     probe: true, ne navigue pas, et cet essai ne compte PAS pour le verrou (failures vides, pas de verrou),
  //     l'état ne passe pas à « dead » pour autant. Sam passe le défi, le prochain appel repart normalement.
  {
    setSite({ limits: { attemptsPerDay: 1 } });   // plafond 1 : un essai compté verrouillerait aussitôt
    await tabTo(`${base}/defi`);
    await new Promise(r => setTimeout(r, 500));
    const stBefore = siteState("demo").state;
    const before = total(), beforeReads = secretReads;
    const r = await login({ site: "demo", caller: "test", waitForCode: false, readSecret });
    assert.equal(r.ok, false);
    assert.equal(r.code, "fail.captcha", `code ${r.code} (${r.message})`);
    assert.equal(r.probe, true, "verdict de la sonde : probe: true");
    assert.equal(r.retry, "human"); assert.equal(typeof r.human, "string");
    assert.equal(total(), before, `la sonde ne doit pas naviguer pendant un défi (${total() - before} requête(s))`);
    assert.equal(secretReads, beforeReads, "aucun secret lu pour un captcha vu par la sonde");
    assert.equal(attemptsToday("demo"), 0, `un captcha vu par la sonde n'est pas un essai (${attemptsToday("demo")})`);
    assert.equal(checkLock(getSite("demo")).locked, false, "aucun verrou pour une observation passive");
    assert.equal(siteState("demo").failures.length, 0, `failures : ${JSON.stringify(siteState("demo").failures)}`);
    assert.equal(siteState("demo").state, stBefore, `l'état ne change pas sur un défi observé (${stBefore} → ${siteState("demo").state})`);
    assert.equal(siteState("demo").lastCode, "fail.captcha", "le dernier code est tout de même noté");
    setSite();
    console.log("  6 (f) captcha vu par la sonde → fail.captcha, probe: true, aucune navigation, pas compté pour le verrou");
  }
} catch (e) {
  failed = e;
} finally {
  try { kc.deleteSecret("demo"); } catch {}
  await stopLaunchedChrome();   // attendu : le filet « exit » n'est qu'un secours (bancs d'essai)
  srv.closeAllConnections?.(); srv.close();
  await new Promise(r => setTimeout(r, 1200));
  fs.rmSync(HOME, { recursive: true, force: true });
}
if (failed) { console.error("❌ probe :", failed.message); process.exit(1); }
console.log("✅ probe OK — session vivante reconnue sans secret ni retour sur la page de connexion ; défi jamais quitté");
