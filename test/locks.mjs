// Mémoire des échecs et verrou d'essais (spécification « connexions robustes », étape 1, §4) : après le
// plafond d'essais bloquants du jour, Sésame n'essaie plus (fail.rate_limited, sans lire le secret ni
// toucher au navigateur) jusqu'au lendemain 09:30 ; unlock-site lève le verrou ; booking/beds24/expedia
// n'ont droit qu'à UN essai par jour, les autres à deux. SESAME_NO_LOCK n'est PAS posé ici : c'est le
// verrou lui-même qu'on teste. Chrome de test headless (port et profil dédiés) + pages locales.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import assert from "node:assert/strict"; import { execFileSync, spawn } from "node:child_process"; import { fileURLToPath, pathToFileURL } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-locks-"));
process.env.SESAME_HOME = HOME;
process.env.SESAME_KEYCHAIN_SERVICE = "sesame-locks-" + process.pid;
process.env.SESAME_CDP_URL = "http://127.0.0.1:9242";
process.env.SESAME_CHROME_HEADLESS = "1";   // aucun Chrome ne doit surgir à l'écran pendant les tests
delete process.env.SESAME_NO_LOCK;          // ce banc teste le verrou : il doit s'appliquer
setTimeout(() => { console.error("⏱ délai global dépassé"); process.exit(2); }, 240000).unref();   // unref : ne retient pas le processus une fois le banc fini

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESAME_BIN = path.join(ROOT, "bin", "sesame.js");
const PORT = 8852;
const base = `http://127.0.0.1:${PORT}`;
let requests = 0;   // toute requête reçue : un essai verrouillé ne doit en provoquer AUCUNE (ni sonde, ni page)
const FIELDS = '<input id="username" name="username" autocomplete="username"><input id="password" name="password" type="password"><button type="submit">Se connecter</button>';
const srv = http.createServer((q, r) => {
  const u = q.url.split("?")[0];
  if (u === "/favicon.ico") { r.writeHead(404); return r.end(); }   // demandé par Chrome après chaque page : jamais compté
  requests++;
  r.setHeader("content-type", "text/html; charset=utf-8");
  // Mot de passe toujours refusé : message dans un [role=alert] du formulaire, champ encore là.
  if (u === "/login-bad") return r.end(`<h1>Connexion</h1><form id="f">${FIELDS}<div id="err"></div></form>
    <script>f.addEventListener("submit", e => { e.preventDefault(); err.setAttribute("role", "alert"); err.textContent = "Mot de passe incorrect. Réessayez."; });</script>`);
  if (u === "/login-ok") return r.end(`<h1>Connexion</h1><form method="get" action="/dashboard">${FIELDS}</form>`);
  if (u === "/dashboard") return r.end('<h1>Tableau de bord</h1><a href="/logout">Déconnexion</a>');
  r.end("<p>accueil</p>");
});
await new Promise(r => srv.listen(PORT, "127.0.0.1", r));

const cfg = await import("../src/config.js");
const kc = await import("../src/keychain.js");
const { connect, allPages, stopLaunchedChrome } = await import("../src/browser.js");
const { login, probe, openLogin } = await import("../src/login.js");
const state = await import("../src/state.js");
const { siteState, checkLock, unlockSite, attemptsToday } = state;
const { getSite } = cfg;

const site = (p, extra = {}) => ({ domain: "127.0.0.1", loginUrl: base + p, policy: "always", selectors: {}, ...extra });
const sites = {
  essai: site("/login-bad", { limits: { attemptsPerDay: 1 } }),   // plafond explicite : 1
  beds: site("/login-bad", { extraDomains: ["beds24.com"] }),     // plafond par défaut 1 (beds24.com dans extraDomains)
  deux: site("/login-bad"),                                        // plafond par défaut 2
};
cfg.saveSites(sites);
for (const k of Object.keys(sites)) kc.setSecret(k, { username: "u", password: "p" });

// Espion : lectures du secret par site.
const reads = {};
const readSecret = key => { reads[key] = (reads[key] || 0) + 1; return { username: "u", password: "p" }; };
const reads_ = k => reads[k] || 0;

/** Ramène l'onglet du site (unique, même domaine pour tous) sur about:blank. */
async function resetTab() {
  const b = await connect();
  for (const p of allPages(b)) if (!p.isClosed() && p.url().startsWith(base)) await p.goto("about:blank").catch(() => {});
  await b.close();
}
/** Prochain 09:30, heure locale (aujourd'hui avant 09:30, sinon demain) — même règle que state.js nextMorning. */
function tomorrow0930() { const d = new Date(); const t = new Date(); t.setHours(9, 30, 0, 0); if (d < t) return t; d.setDate(d.getDate() + 1); d.setHours(9, 30, 0, 0); return d; }
const sameInstant = (iso, d) => Math.abs(new Date(iso).getTime() - d.getTime()) < 1000;

let failed = null;
try {
  // 1. Plafond 1 : le premier essai refusé compte, le verrou est posé jusqu'au lendemain 09:30.
  {
    const r = await login({ site: "essai", caller: "test", waitForCode: false, readSecret });
    assert.equal(r.ok, false, `mot de passe refusé attendu : ${r.message}`);
    assert.equal(r.code, "fail.password_rejected", `code ${r.code} (${r.message})`);
    assert.equal(reads_("essai"), 1, "le secret a été lu pour ce premier essai");
    assert.equal(attemptsToday("essai"), 1, `attemptsToday : ${attemptsToday("essai")}`);
    const lock = checkLock(getSite("essai"));
    assert.equal(lock.locked, true, `verrou attendu après 1 essai sur 1 : ${JSON.stringify(lock)}`);
    assert.ok(sameInstant(lock.until, tomorrow0930()), `verrou jusqu'au lendemain 09:30 local, pas ${lock.until}`);
    assert.equal(lock.reason, "fail.password_rejected", `motif du verrou : ${lock.reason}`);
    const st = siteState("essai");
    assert.equal(st.lastOutcome, "fail"); assert.equal(st.lastCode, "fail.password_rejected");
    assert.equal(st.failures?.length, 1, `failures : ${JSON.stringify(st.failures)}`);
    assert.equal(st.failures[0].code, "fail.password_rejected");
    assert.ok(st.lockedUntil, "lockedUntil attendu");
    // Fichier d'état : HOME/state/sessions.json, dossier 0700, fichier 0600, pas de .tmp qui traîne.
    const dir = path.join(HOME, "state"), file = path.join(dir, "sessions.json");
    assert.ok(fs.existsSync(file), `fichier d'état attendu : ${file}`);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "dossier state en 0700");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "sessions.json en 0600");
    assert.ok(!fs.readdirSync(dir).some(n => n.endsWith(".tmp")), "écriture atomique : aucun .tmp restant");
    assert.ok(!fs.readFileSync(file, "utf8").includes('"password"'), "jamais de secret dans l'état");
    const all = state.readState();
    assert.equal((all.essai || all.sites?.essai)?.lastCode, "fail.password_rejected", `readState() rend le même état : ${JSON.stringify(all).slice(0, 200)}`);
    console.log("  1 limits.attemptsPerDay: 1 → 1er essai fail.password_rejected, verrou jusqu'au lendemain 09:30, état écrit (0600)");
  }

  // 2. Essai suivant : fail.rate_limited, AUCUNE lecture du secret, AUCUNE requête (ni sonde, ni page), état blocked.
  {
    requests = 0;
    const r = await login({ site: "essai", caller: "test", waitForCode: false, readSecret });
    assert.equal(r.ok, false);
    assert.equal(r.code, "fail.rate_limited", `code ${r.code} (${r.message})`);
    assert.equal(r.outcome, "fail"); assert.equal(r.retry, "later"); assert.equal(r.actor, "none");
    assert.equal(reads_("essai"), 1, "le secret ne doit PAS être lu quand le verrou est posé");
    assert.equal(requests, 0, `le verrou doit précéder la sonde : ${requests} requête(s) reçue(s)`);
    assert.ok(sameInstant(r.retryAfter, tomorrow0930()), `retryAfter au lendemain 09:30 local, pas ${r.retryAfter}`);
    assert.equal(typeof r.human, "string", "chemin humain attendu");
    assert.match(r.human, /sesame_open_login/, `human : ${r.human}`);
    assert.match(r.human, /unlock-site essai/, `human : ${r.human}`);
    assert.match(r.message, /essai/, `message : ${r.message}`);
    assert.match(r.message, /09[:h]30/, `message : ${r.message}`);
    assert.match(r.message, /password_rejected|mot de passe|password/i, `message : ${r.message}`);
    assert.equal(siteState("essai").state, "blocked", `état : ${siteState("essai").state}`);
    assert.equal(attemptsToday("essai"), 1, "un essai verrouillé ne compte pas comme un essai");
    console.log("  2 2e essai → fail.rate_limited sans lecture du secret ni requête, retryAfter lendemain 09:30, état blocked");
  }

  // 3. unlockSite → l'essai redevient possible (ici la page accepte : ok.signed_in, état alive).
  {
    unlockSite("essai");
    const lock = checkLock(getSite("essai"));
    assert.equal(lock.locked, false, `verrou encore posé après unlockSite : ${JSON.stringify(lock)}`);
    assert.ok(!siteState("essai").lockedUntil, "lockedUntil doit être levé");
    await resetTab();
    sites.essai = site("/login-ok", { limits: { attemptsPerDay: 1 } }); cfg.saveSites(sites);
    const r = await login({ site: "essai", caller: "test", waitForCode: false, readSecret });
    assert.equal(r.ok, true, `après unlockSite, la connexion doit être tentée : ${r.message}`);
    assert.equal(r.code, "ok.signed_in", `code ${r.code}`);
    assert.equal(reads_("essai"), 2);
    assert.equal(siteState("essai").state, "alive");
    console.log("  3 unlockSite → essai possible, connexion réussie, état alive");
  }

  // 4. Défaut 1 pour un site dont extraDomains contient beds24.com ; `sesame unlock-site` et `sesame state` en CLI.
  {
    await resetTab();
    const r1 = await login({ site: "beds", caller: "test", waitForCode: false, readSecret });
    assert.equal(r1.code, "fail.password_rejected", `code ${r1.code} (${r1.message})`);
    assert.equal(checkLock(getSite("beds")).locked, true, "beds24.com → un seul essai par jour");
    const r2 = await login({ site: "beds", caller: "test", waitForCode: false, readSecret });
    assert.equal(r2.code, "fail.rate_limited", `code ${r2.code} (${r2.message})`);
    assert.equal(reads_("beds"), 1);
    const out = execFileSync(process.execPath, [SESAME_BIN, "unlock-site", "beds"], { encoding: "utf8", env: process.env, timeout: 30000 });
    assert.match(out, /beds/, `sortie de unlock-site : ${out}`);
    assert.equal(checkLock(getSite("beds")).locked, false, "le verrou doit être levé par la CLI");
    const shown = execFileSync(process.execPath, [SESAME_BIN, "state", "beds"], { encoding: "utf8", env: process.env, timeout: 30000 });
    assert.match(shown, /beds/, `sortie de state : ${shown}`);
    assert.ok(!/"password"|motdepasse/.test(shown), "sesame state n'affiche jamais de secret");
    const all = execFileSync(process.execPath, [SESAME_BIN, "state"], { encoding: "utf8", env: process.env, timeout: 30000 });
    assert.match(all, /essai/); assert.match(all, /beds/);
    console.log("  4 extraDomains beds24.com → plafond 1 ; sesame unlock-site et sesame state en CLI");
  }

  // 5. Défaut 2 pour un site ordinaire ; le verrou ne touche ni openLogin(), ni probe().
  {
    await resetTab();
    const r1 = await login({ site: "deux", caller: "test", waitForCode: false, readSecret });
    assert.equal(r1.code, "fail.password_rejected", `code ${r1.code} (${r1.message})`);
    assert.equal(checkLock(getSite("deux")).locked, false, "un site ordinaire a droit à deux essais");
    assert.equal(attemptsToday("deux"), 1);
    await resetTab();
    const r2 = await login({ site: "deux", caller: "test", waitForCode: false, readSecret });
    assert.equal(r2.code, "fail.password_rejected", `code ${r2.code} (${r2.message})`);
    assert.equal(attemptsToday("deux"), 2);
    assert.equal(checkLock(getSite("deux")).locked, true, "deux essais bloquants → verrou");
    const r3 = await login({ site: "deux", caller: "test", waitForCode: false, readSecret });
    assert.equal(r3.code, "fail.rate_limited", `code ${r3.code} (${r3.message})`);
    assert.equal(reads_("deux"), 2);
    assert.equal(siteState("deux").failures.length, 2);
    // Verrou posé, mais ouvrir la page et sonder restent permis (c'est le chemin humain).
    const o = await openLogin({ site: "deux", caller: "test" });
    assert.equal(o.ok, true, `openLogin sous verrou : ${o.message}`);
    const p = await probe({ site: "deux", caller: "test" });
    assert.equal(p.ok, true, `probe sous verrou : ${p.message}`);
    assert.equal(reads_("deux"), 2, "ni openLogin ni probe ne lisent le secret");
    console.log("  5 site ordinaire → plafond 2 ; openLogin et probe passent malgré le verrou");
  }

  // 6. Écritures concurrentes (plusieurs serveurs MCP Sésame en même temps : Claude Code, Cowork, app) : 8 processus
  //    enregistrent chacun 5 résultats dans le même sessions.json. Aucune mise à jour perdue, aucun JSON tronqué,
  //    les verrous déjà posés (essai, beds, deux) survivent, ni .tmp ni .lock ne traînent.
  {
    const before = state.readState();
    const stateUrl = pathToFileURL(path.join(ROOT, "src", "state.js")).href;
    const child = `import { recordOutcome } from ${JSON.stringify(stateUrl)};
      for (let i = 0; i < 5; i++) recordOutcome(process.env.SITE_PREFIX + "-" + i, { ok: false, outcome: "fail", code: "fail.password_rejected", url: "https://exemple.test/x" }, { domain: "exemple.test" });`;
    const procs = Array.from({ length: 8 }, (_, n) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", child], { env: { ...process.env, SITE_PREFIX: `conc${n}` }, stdio: ["ignore", "ignore", "pipe"] });
      let err = ""; p.stderr.on("data", d => { err += d; });
      p.on("exit", code => code === 0 ? resolve() : reject(new Error(`processus ${n} sorti en ${code} : ${err.slice(0, 300)}`)));
    }));
    await Promise.all(procs);
    const all = state.readState();
    const expected = Array.from({ length: 8 }, (_, n) => Array.from({ length: 5 }, (_, i) => `conc${n}-${i}`)).flat();
    const missing = expected.filter(k => !all[k] || all[k].lastCode !== "fail.password_rejected");
    assert.equal(missing.length, 0, `${missing.length} mise(s) à jour perdue(s) : ${missing.slice(0, 6).join(", ")}`);
    for (const k of ["essai", "beds", "deux"]) assert.deepEqual(all[k], before[k], `état de « ${k} » altéré par les écritures concurrentes`);
    const dir = path.join(HOME, "state");
    assert.ok(!fs.readdirSync(dir).some(n => n.endsWith(".tmp") || n.endsWith(".lock")), `fichiers restants : ${fs.readdirSync(dir).join(", ")}`);
    console.log("  6 8 processus × 5 écritures concurrentes → 40 états présents, verrous conservés, ni .tmp ni .lock restants");
  }
} catch (e) {
  failed = e;
} finally {
  for (const k of Object.keys(sites)) { try { kc.deleteSecret(k); } catch {} }
  await stopLaunchedChrome();   // attendu : le filet « exit » n'est qu'un secours (bancs d'essai)
  srv.closeAllConnections?.(); srv.close();
  await new Promise(r => setTimeout(r, 1200));
  fs.rmSync(HOME, { recursive: true, force: true });
}
if (failed) { console.error("❌ locks :", failed.message); process.exit(1); }
console.log("✅ locks OK — plafond d'essais respecté, verrou sans lecture du secret, levée par unlock-site");
