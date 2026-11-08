// Profil Chrome qui reprend sa session (spécification « connexions robustes », étape 1, §6) :
// prepareChromeProfile() pose les clés de Preferences (session restaurée, sortie « propre », pas de
// gestionnaire de mots de passe), supprime les Singleton* qui traînent, préserve le reste du fichier, et ne
// touche à RIEN quand un Chrome tourne déjà sur ce profil. Aucun Chrome n'est lancé : profil temporaire sous
// SESAME_HOME, détection « occupé » injectée par SESAME_PROFILE_BUSY_CMD (commande qui sort 0 si occupé).
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import assert from "node:assert/strict";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-profile-"));
process.env.SESAME_HOME = HOME;
process.env.SESAME_KEYCHAIN_SERVICE = "sesame-profile-" + process.pid;
process.env.SESAME_CDP_URL = "http://127.0.0.1:9244";   // port dédié (aucun Chrome n'est lancé ici)
process.env.SESAME_CHROME_HEADLESS = "1";
delete process.env.SESAME_PROFILE_BUSY_CMD;
setTimeout(() => { console.error("⏱ délai global dépassé"); process.exit(2); }, 30000).unref();   // unref : ne retient pas le processus une fois le banc fini

const { CHROME_PROFILE } = await import("../src/config.js");
const browser = await import("../src/browser.js");
const prepareChromeProfile = async o => browser.prepareChromeProfile(o);   // synchrone dans la spécification ; `await` neutre sinon
assert.equal(typeof browser.prepareChromeProfile, "function", "prepareChromeProfile doit être exporté par src/browser.js");
assert.ok(CHROME_PROFILE.startsWith(HOME), `le profil de test doit être sous SESAME_HOME : ${CHROME_PROFILE}`);

const DEFAULT = path.join(CHROME_PROFILE, "Default");
const PREFS = path.join(DEFAULT, "Preferences");
const SINGLETONS = ["SingletonLock", "SingletonSocket", "SingletonCookie"].map(n => path.join(CHROME_PROFILE, n));
const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };   // lstat : un lien mort compte comme présent
const readPrefs = () => JSON.parse(fs.readFileSync(PREFS, "utf8"));
const EXPECTED = p => {
  assert.equal(p.session?.restore_on_startup, 1, "session.restore_on_startup = 1");
  assert.equal(p.profile?.exit_type, "Normal", "profile.exit_type = Normal");
  assert.equal(p.profile?.exited_cleanly, true, "profile.exited_cleanly = true");
  assert.equal(p.credentials_enable_service, false, "credentials_enable_service = false");
  assert.equal(p.profile?.password_manager_enabled, false, "profile.password_manager_enabled = false");
};
/** Profil « sale » : Preferences d'un Chrome tué (Crashed), clés étrangères à préserver, Singleton* qui traînent. */
function dirtyProfile() {
  fs.rmSync(CHROME_PROFILE, { recursive: true, force: true });
  fs.mkdirSync(DEFAULT, { recursive: true });
  fs.writeFileSync(PREFS, JSON.stringify({
    foo: { bar: 1, liste: [1, 2, 3] },
    profile: { exit_type: "Crashed", exited_cleanly: false, name: "Personne", password_manager_enabled: true },
    session: { restore_on_startup: 5, startup_urls: ["https://exemple.fr/"] },
    credentials_enable_service: true,
    browser: { has_seen_welcome_page: true },
  }));
  fs.symlinkSync("hote-12345", SINGLETONS[0]);          // SingletonLock : lien symbolique mort, comme Chrome le laisse
  fs.writeFileSync(SINGLETONS[1], ""); fs.writeFileSync(SINGLETONS[2], "");
}

let failed = null;
try {
  // 1. Profil sale, aucun Chrome dessus : clés posées, étrangères préservées, Singleton* supprimés, écriture atomique.
  {
    dirtyProfile();
    await prepareChromeProfile();
    for (const s of SINGLETONS) assert.ok(!exists(s), `${path.basename(s)} doit être supprimé`);
    const p = readPrefs();
    EXPECTED(p);
    assert.equal(p.foo?.bar, 1, "clé étrangère foo.bar préservée");
    assert.deepEqual(p.foo?.liste, [1, 2, 3], "clé étrangère foo.liste préservée");
    assert.equal(p.profile?.name, "Personne", "profile.name préservé à côté des clés posées");
    assert.deepEqual(p.session?.startup_urls, ["https://exemple.fr/"], "session.startup_urls préservé");
    assert.equal(p.browser?.has_seen_welcome_page, true, "browser.* préservé");
    assert.ok(!fs.readdirSync(DEFAULT).some(n => n.endsWith(".tmp")), "écriture atomique : aucun .tmp restant");
    console.log("  1 profil sale → clés posées, clés étrangères préservées, Singleton* supprimés");
  }
  // 2. Premier lancement (aucun Preferences) : Default/ et un Preferences minimal sont créés.
  {
    fs.rmSync(CHROME_PROFILE, { recursive: true, force: true });
    fs.mkdirSync(CHROME_PROFILE, { recursive: true });
    await prepareChromeProfile();
    assert.ok(fs.existsSync(PREFS), "Default/Preferences doit être créé au premier lancement");
    EXPECTED(readPrefs());
    console.log("  2 premier lancement → Default/Preferences minimal créé avec les clés");
  }
  // 2b. Profil absent (même le dossier) : créé aussi, sans erreur.
  {
    fs.rmSync(CHROME_PROFILE, { recursive: true, force: true });
    await prepareChromeProfile();
    assert.ok(fs.existsSync(PREFS), "le profil et son Preferences doivent être créés");
    EXPECTED(readPrefs());
    console.log("  2b profil absent → créé");
  }
  // 3. Un Chrome « tourne » sur ce profil (détection injectée : commande qui sort 0) : rien n'est touché.
  {
    dirtyProfile();
    const before = fs.readFileSync(PREFS, "utf8");
    process.env.SESAME_PROFILE_BUSY_CMD = "true";
    await prepareChromeProfile();
    for (const s of SINGLETONS) assert.ok(exists(s), `${path.basename(s)} ne doit pas être touché quand Chrome tourne`);
    assert.equal(fs.readFileSync(PREFS, "utf8"), before, "Preferences ne doit pas être modifié quand Chrome tourne");
    console.log("  3 un Chrome tourne sur le profil → rien touché");
  }
  // 4. La même commande dit « libre » (sort 1) : le même profil est nettoyé.
  {
    process.env.SESAME_PROFILE_BUSY_CMD = "false";
    await prepareChromeProfile();
    for (const s of SINGLETONS) assert.ok(!exists(s), `${path.basename(s)} doit être supprimé une fois Chrome parti`);
    EXPECTED(readPrefs());
    delete process.env.SESAME_PROFILE_BUSY_CMD;
    console.log("  4 Chrome parti (commande qui sort 1) → profil nettoyé");
  }
  // 5. Preferences illisible : aucune exception ne remonte (erreur ignorée, journalisée si onEvent est fourni).
  {
    fs.rmSync(CHROME_PROFILE, { recursive: true, force: true });
    fs.mkdirSync(DEFAULT, { recursive: true });
    fs.writeFileSync(PREFS, "{ pas du json");
    fs.writeFileSync(SINGLETONS[1], "");
    const events = [];
    await prepareChromeProfile({ onEvent: e => events.push(e) });
    assert.ok(fs.existsSync(PREFS), "un Preferences illisible n'est pas supprimé");
    assert.ok(events.every(e => typeof (e?.detail ?? "") === "string"), "les événements portent un detail texte");
    console.log(`  5 Preferences illisible → aucune exception (${events.length} événement(s) journalisé(s))`);
  }
  // 6. Filet « exit » (SIGTERM au Chrome lancé) : réservé aux bancs d'essai (SESAME_CHROME_HEADLESS=1) ou à une
  //    demande explicite (SESAME_KILL_CHROME_ON_EXIT=1). En production, aucune des deux : le Chrome Sésame survit
  //    au processus MCP qui l'a lancé (Sam y travaille, d'autres clients le partagent).
  {
    assert.equal(typeof browser.killChromeOnExit, "function", "killChromeOnExit doit être exporté");
    assert.equal(browser.exitHookArmed(), false, "aucun Chrome lancé ici : filet non posé");
    assert.equal(browser.killChromeOnExit(), true, "bancs d'essai (SESAME_CHROME_HEADLESS=1) : filet autorisé");
    const saved = process.env.SESAME_CHROME_HEADLESS;
    delete process.env.SESAME_CHROME_HEADLESS; delete process.env.SESAME_KILL_CHROME_ON_EXIT;
    assert.equal(browser.killChromeOnExit(), false, "production (ni headless ni demande explicite) : le Chrome Sésame ne doit JAMAIS être tué à la sortie");
    process.env.SESAME_KILL_CHROME_ON_EXIT = "1";
    assert.equal(browser.killChromeOnExit(), true, "SESAME_KILL_CHROME_ON_EXIT=1 : filet autorisé sur demande");
    delete process.env.SESAME_KILL_CHROME_ON_EXIT; process.env.SESAME_CHROME_HEADLESS = saved;
    console.log("  6 filet « exit » : bancs d'essai seulement, jamais en production");
  }
} catch (e) { failed = e; } finally {
  delete process.env.SESAME_PROFILE_BUSY_CMD;
  fs.rmSync(HOME, { recursive: true, force: true });
}
if (failed) { console.error("❌ chrome-profile :", failed.message); process.exit(1); }
console.log("✅ chrome-profile OK — session restaurée, sortie propre, Singleton* nettoyés, rien touché si Chrome tourne");
