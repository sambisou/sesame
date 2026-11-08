// Connexion à Chrome (protocole DevTools) et remplissage des champs.
// Chrome doit tourner avec --remote-debugging-port (voir `sesame chrome`).
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync, execSync } from "node:child_process";
import { chromium } from "playwright-core";
import { CDP_URL, CHROME_PROFILE, siteMatchesUrl, hostnameOf, siteDomainFor, validateExtraDomain, isProviderUrl, isProviderSite, normalizeAccount } from "./config.js";
import { t } from "./i18n.js";
import { withOutcome } from "./outcomes.js";

// Champs de recherche et assimilés : jamais un identifiant.
const NOT_SEARCH = ':not([type="search"]):not([role="searchbox"]):not([name*="search" i]):not([id*="search" i]):not([name*="recherche" i]):not([id*="recherche" i]):not([name="q"]):not([placeholder*="recherch" i]):not([placeholder*="search" i])';
// Champs identifiant FORTS (suffisent seuls) et FAIBLES (un simple champ texte : accepté seulement sur la page de
// connexion déclarée, ou à côté d'un champ mot de passe — sinon n'importe quel formulaire du site passerait pour un login).
const USER_STRONG = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name*="email" i]', 'input[id*="email" i]',
  'input[name*="user" i]', 'input[id*="user" i]', 'input[name*="login" i]', 'input[id*="login" i]',
  'input[name*="identifiant" i]', 'input[id*="identifiant" i]',
];
const USER_WEAK = [`input[type="tel"]${NOT_SEARCH}`, `input[type="text"]${NOT_SEARCH}`];
const USER_SELECTORS = [...USER_STRONG, ...USER_WEAK];
const PASS_SELECTORS = ['input[type="password"]'];
const SUBMIT_SELECTORS = [
  'button[type="submit"]', 'input[type="submit"]',
  'button:has-text("Se connecter")', 'button:has-text("Connexion")', 'button:has-text("Valider")',
  'button:has-text("Continuer")', 'button:has-text("Suivant")',
  'button:has-text("Sign in")', 'button:has-text("Log in")', 'button:has-text("Login")',
  'button:has-text("Next")', 'button:has-text("Continue")', 'button:has-text("Anmelden")', 'button:has-text("Weiter")',
];

// 2e facteur. Les sélecteurs FORTS suffisent seuls ; les FAIBLES doivent être corroborés par un texte explicite
// (sinon un code postal, un code promo ou une quantité passeraient pour un code de vérification).
const OTP_STRONG = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]', 'input[id*="otp" i]',
  'input[name*="totp" i]', 'input[id*="totp" i]',
  'input[name*="mfa" i]', 'input[id*="mfa" i]',
  'input[name*="2fa" i]', 'input[id*="2fa" i]',
  'input[name*="onetime" i]', 'input[id*="onetime" i]', 'input[name*="one-time" i]', 'input[id*="one-time" i]',
];
const OTP_WEAK = [
  'input[name*="verif" i]', 'input[id*="verif" i]',
  'input[name*="token" i]', 'input[id*="token" i]',
  'input[name*="code" i]', 'input[id*="code" i]', 'input[placeholder*="code" i]', 'input[aria-label*="code" i]',
  'input[inputmode="numeric"]', 'input[type="tel"]', 'input[type="text"]', 'input[type="number"]',
];
const OTP_TEXT = /code (de |d')?(vérification|verification|sécurité|securite|confirmation|validation|à usage unique|unique)|code (reçu|recu|envoyé|envoye|transmis)|(envoyé|envoye|reçu|recu) par (sms|e-?mail|courriel|mail)|code (à|a|de) \d+ chiffres|saisis(?:sez)? (?:le|votre) code|entrez (?:le|votre) code|verification code|security code|one-time (code|password)|\d[- ]digit code|code (that|we) sent|sent (you|to you) (a|the) code|enter (the|your|a) code|two-factor|2fa|deux facteurs|double authentification|authentification forte|authenticator/i;

// Écran « session déjà ouverte / choix de compte » (ex. Orange keep-connected) : bouton pour continuer avec le
// compte affiché, lien pour changer de compte, jamais un bouton de déconnexion.
const CONTINUE_TEXT_RE = /continuer avec ce compte|continuer en tant que|rester connect[ée]|continue (with|as)( this account)?|c'est (bien )?moi|use this account|keep me signed in/i;
const SWITCH_TEXT_RE = /changer de compte|autre compte|use another account|switch account|not you/i;
const LOGOUT_TEXT_RE = /d[ée]connexion|logout|sign out|supprimer/i;
// Entrée vers le formulaire quand il est caché derrière un bouton ou un lien (« ESPACE PRIVÉ » chez CM2C,
// « Se connecter » dans l'en-tête de beaucoup de sites). Jamais une création de compte ni une déconnexion.
// Connexion par fournisseur d'identité (« Sign in with Google »…). Sésame peut CLIQUER ce bouton et
// laisser la session déjà ouverte dans son navigateur terminer ; il n'y tape JAMAIS d'identifiant — la page
// du fournisseur est hors du périmètre du site, et onSite() interdit déjà toute frappe hors périmètre.
const PROVIDERS = {
  google:    { label: "Google",    re: /(se connecter|connexion|continuer|s'identifier|sign ?in|log ?in|continue)\s*(avec|with|via)?\s*google|google\s*(sign|log)\s*-?\s*in/i },
  apple:     { label: "Apple",     re: /(se connecter|continuer|sign ?in|continue)\s*(avec|with|via)?\s*apple/i },
  github:    { label: "GitHub",    re: /(se connecter|continuer|sign ?in|continue)\s*(avec|with|via)?\s*github/i },
  microsoft: { label: "Microsoft", re: /(se connecter|continuer|sign ?in|continue)\s*(avec|with|via)?\s*(microsoft|azure|office ?365)/i },
};
/** Le site dit-il lui-même que ce compte passe par une authentification unique ? */
const SSO_TEXT_RE = /single sign-?on|\bSSO\b|authentification unique|identity provider|fournisseur d'identit[ée]|votre organisation|your organization('s)? (identity|sign-?in)/i;

const LOGIN_ENTRY_RE = /se connecter|connexion|espace priv[ée]|identifiez-vous|mon compte|my account|log ?in|sign ?in/i;
// Entrée « se connecter » d'une page publique, pour un site fournisseur (sans « mon compte » : il figure aussi sur une session ouverte).
const PROVIDER_ENTRY_RE = /se connecter|connexion|identifiez-vous|log ?in|sign ?in/i;
const LOGIN_ENTRY_EXCLUDE_RE = /cr[ée]er|inscri|nouveau compte|register|sign ?up|d[ée]connexion|log ?out|sign ?out|aide|assistance|oubli/i;
// Signe d'une session DÉJÀ OUVERTE : la page offre de se déconnecter. Volontairement strict — « Mon compte »
// ou « Connexion » figurent aussi sur les pages déconnectées, un lien de déconnexion non.
const SIGNED_IN_TEXT_RE = /d[ée]connexion|se d[ée]connecter|log\s?out|sign\s?out/i;
const SIGNED_IN_HREF_RE = /log-?out|sign-?out|d[ée]connexion|deconnexion|logoff/i;
const ACCOUNT_CLICKABLE = 'button, a, [role="button"], input[type="submit"], input[type="button"], summary';
// Adresse e-mail affichée, en clair ou masquée (j***@exemple.fr) : préfixe visible + astérisques/points/points
// de suspension éventuels, puis @domaine.
const EMAIL_CANDIDATE_RE = /[a-z0-9][a-z0-9._%+-]*[*•.…]*@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** État du port DevTools : "down" (rien n'écoute), "foreign" (autre chose qu'un Chrome Sésame), "up" (le nôtre). */
async function cdpProbe() {
  let info;
  try {
    const r = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return "foreign";
    info = await r.json();
  } catch (e) {
    return e?.cause?.code === "ECONNREFUSED" || /ECONNREFUSED/.test(String(e?.message)) ? "down" : "foreign";
  }
  const ws = info?.webSocketDebuggerUrl;
  if (!ws) return "foreign";
  // Est-ce bien NOTRE Chrome ? Le processus qui écoute sur le port doit avoir été lancé avec le profil Sésame.
  try {
    const port = new URL(CDP_URL).port || "9222";
    const pid = execFileSync("/usr/sbin/lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 3000 }).trim().split("\n")[0];
    if (!pid) return "foreign";
    const cmd = execFileSync("/bin/ps", ["-o", "command=", "-p", pid], { encoding: "utf8", timeout: 3000 });
    return cmd.includes(`--user-data-dir=${CHROME_PROFILE}`) ? "up" : "foreign";
  } catch { return "foreign"; }
}
async function cdpReachable() { return (await cdpProbe()) === "up"; }

/** Ramène le Chrome Sésame devant (Page.bringToFront n'active pas l'application sur macOS). */
export function activateChrome() {
  try {
    const pids = execFileSync("/usr/bin/pgrep", ["-f", "--", `--user-data-dir=${CHROME_PROFILE}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    if (pids[0]) execFileSync("/usr/bin/osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${Number(pids[0])}) to true`], { stdio: "ignore", timeout: 3000 });
  } catch {}
}

let launching = null;
/**
 * Lance le Chrome « Sésame » (profil dédié, port DevTools) comme `sesame chrome`, et attend qu'il réponde.
 * UN SEUL navigateur : deux connexions simultanées (deux outils MCP à la fois) partagent le même lancement
 * au lieu d'en démarrer deux, et un Chrome déjà debout n'est jamais doublé.
 */
export async function launchChrome(opts = {}) {
  if (launching) return launching;
  if (await cdpReachable()) return true;   // déjà debout : ne rien lancer
  launching = launchChromeOnce(opts).finally(() => { launching = null; });
  return launching;
}

/** PID des processus Chrome lancés sur un profil (le profil Sésame par défaut), jamais le Chrome habituel de l'utilisateur. */
function chromePidsOnProfile(profile = CHROME_PROFILE) {
  try {
    return execFileSync("/usr/bin/pgrep", ["-f", "--", `--user-data-dir=${profile}`], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean).map(Number).filter(n => Number.isInteger(n) && n !== process.pid);
  } catch { return []; }
}

/**
 * Un Chrome tourne-t-il déjà sur ce profil ? Vérité : `pgrep -f -- --user-data-dir=<profil>`. Pour les bancs
 * d'essai, injectable : SESAME_PROFILE_BUSY=1 (occupé) ou SESAME_PROFILE_BUSY_CMD=<commande shell> (code de
 * retour 0 = occupé), sans avoir à lancer un vrai Chrome.
 */
export function chromeProfileBusy(profile = CHROME_PROFILE) {
  if (process.env.SESAME_PROFILE_BUSY === "1") return true;
  if (process.env.SESAME_PROFILE_BUSY === "0") return false;
  if (process.env.SESAME_PROFILE_BUSY_CMD) {
    try { execSync(process.env.SESAME_PROFILE_BUSY_CMD, { stdio: "ignore", timeout: 5000, env: { ...process.env, SESAME_PROFILE: profile } }); return true; }
    catch { return false; }
  }
  return chromePidsOnProfile(profile).length > 0;
}

/** Écriture atomique d'un fichier du profil (.tmp puis rename), mode 0600. */
function writeAtomic(file, content) {
  const tmp = `${file}.sesame-tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Prépare le profil Chrome Sésame AVANT de le lancer, et seulement si aucun Chrome ne tourne dessus :
 *  - retire les verrous `SingletonLock`, `SingletonSocket`, `SingletonCookie` laissés par un arrêt brutal
 *    (sinon Chrome refuse de s'ouvrir ou ouvre un profil vierge) ;
 *  - pose dans `Default/Preferences` : session.restore_on_startup = 1 (reprendre les onglets, donc les
 *    sessions), profile.exit_type = "Normal" et profile.exited_cleanly = true (plus de bandeau « Chrome ne
 *    s'est pas fermé correctement »), credentials_enable_service = false et
 *    profile.password_manager_enabled = false (Chrome ne propose jamais d'enregistrer les mots de passe que
 *    Sésame tape). Sans Preferences (premier lancement) : Default/ et un Preferences minimal sont créés.
 * Mêmes clés sur macOS et Linux (atelier). Aucune erreur ne remonte : elle est rapportée par `onEvent`.
 * Renvoie { done, skipped?, reason?, removed: [...], prefs: "créé"|"modifié"|"inchangé"|null }.
 */
export function prepareChromeProfile({ profile = CHROME_PROFILE, onEvent = () => {}, busy } = {}) {
  const report = { done: false, removed: [], prefs: null };
  try {
    const occupied = typeof busy === "boolean" ? busy : typeof busy === "function" ? !!busy(profile) : chromeProfileBusy(profile);
    if (occupied) {
      report.skipped = true; report.reason = "un Chrome tourne déjà sur ce profil : rien touché";
      onEvent({ result: "étape", detail: `profil Chrome non préparé (${report.reason})` });
      return report;
    }
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      const p = path.join(profile, name);
      try {
        fs.lstatSync(p);           // liens symboliques (SingletonLock pointe vers « hôte-pid ») : lstat, pas stat
        fs.rmSync(p, { force: true });
        report.removed.push(name);
      } catch { /* absent */ }
    }
    const dir = path.join(profile, "Default");
    const file = path.join(dir, "Preferences");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let prefs = {};
    let existed = false;
    if (fs.existsSync(file)) {
      existed = true;
      try { prefs = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { onEvent({ result: "étape", detail: `Preferences illisible (${errCause(e)}) : réécrit` }); prefs = {}; }
      if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) prefs = {};
    }
    const before = JSON.stringify(prefs);
    prefs.session = { ...(prefs.session && typeof prefs.session === "object" ? prefs.session : {}), restore_on_startup: 1 };
    prefs.profile = { ...(prefs.profile && typeof prefs.profile === "object" ? prefs.profile : {}), exit_type: "Normal", exited_cleanly: true, password_manager_enabled: false };
    prefs.credentials_enable_service = false;
    const after = JSON.stringify(prefs);
    if (!existed) { writeAtomic(file, after); report.prefs = "créé"; }
    else if (after !== before) { writeAtomic(file, after); report.prefs = "modifié"; }
    else report.prefs = "inchangé";
    report.done = true;
    if (report.removed.length || report.prefs !== "inchangé") {
      onEvent({ result: "étape", detail: `profil Chrome préparé : Preferences ${report.prefs}${report.removed.length ? `, ${report.removed.join(", ")} retiré(s)` : ""}` });
    }
  } catch (e) {
    report.reason = errCause(e);
    onEvent({ result: "étape", detail: `préparation du profil Chrome ignorée : ${report.reason}` });
  }
  return report;
}

async function launchChromeOnce({ waitMs = 15000, onEvent = () => {} } = {}) {
  const bin = process.env.SESAME_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!fs.existsSync(bin)) throw new Error("Google Chrome n'est pas dans /Applications : installe-le, ou lance le Chrome Sésame à la main.");
  const port = CDP_URL.split(":").pop();
  // Profil qui reprend sa session et ne garde pas de verrou périmé — seulement si aucun Chrome n'y tourne.
  prepareChromeProfile({ onEvent });
  // SESAME_CHROME_HEADLESS=1 : Chrome sans fenêtre. Réservé aux bancs d'essai — ils ne doivent pas faire
  // surgir de fenêtres sur l'écran de l'utilisateur pendant qu'ils tournent.
  const headless = process.env.SESAME_CHROME_HEADLESS === "1" ? ["--headless=new"] : [];
  // Sur un écran virtuel sans gestionnaire de fenêtres (serveur), la fenêtre doit remplir l'écran
  // elle-même : SESAME_WINDOW="1440,1000". Sans cette variable (Mac), rien ne change.
  const fenetre = process.env.SESAME_WINDOW ? [`--window-size=${process.env.SESAME_WINDOW}`, "--window-position=0,0"] : [];
  // Options supplémentaires du serveur (SESAME_CHROME_FLAGS, séparées par des espaces) : WebGL
  // logiciel, langue… — un navigateur sans WebGL ni langue est noté « robot » par certains sites.
  const extra = (process.env.SESAME_CHROME_FLAGS || "").split(/\s+/).filter(Boolean);
  const child = spawn(bin, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${CHROME_PROFILE}`,
    "--no-first-run", "--no-default-browser-check", "--password-store=basic", ...headless, ...fenetre, ...extra, "about:blank",
  ], { detached: true, stdio: "ignore" });
  child.unref();
  launchedPid = child.pid;
  // Filet RÉSERVÉ AUX BANCS D'ESSAI (killChromeOnExit) : à la sortie du processus, le Chrome lancé ici reçoit
  // au moins SIGTERM (un gestionnaire « exit » ne peut rien attendre d'asynchrone). Jamais en production : le
  // Chrome Sésame survit au processus qui l'a lancé — plusieurs clients MCP (Claude Code, Cowork, app) le
  // partagent, et l'utilisateur y travaille (code à taper, extranet ouvert) quand un serveur MCP s'arrête.
  if (killChromeOnExit() && !exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => { if (launchedPid) { try { process.kill(launchedPid, "SIGTERM"); } catch {} } });
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await cdpReachable()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
let launchedPid = null;
let exitHookInstalled = false;

/**
 * Le Chrome lancé par ce processus doit-il recevoir SIGTERM quand le processus sort ? Seulement pour les bancs
 * d'essai (SESAME_CHROME_HEADLESS=1) ou sur demande explicite (SESAME_KILL_CHROME_ON_EXIT=1). En production,
 * jamais : le Chrome Sésame (profil qui reprend sa session) est partagé et survit à son lanceur.
 */
export function killChromeOnExit() {
  return process.env.SESAME_CHROME_HEADLESS === "1" || process.env.SESAME_KILL_CHROME_ON_EXIT === "1";
}
/** Le filet « exit » a-t-il été posé dans ce processus ? (bancs d'essai) */
export function exitHookArmed() { return exitHookInstalled; }

/**
 * Arrêt PROPRE par le protocole : Browser.close ferme les onglets et laisse Chrome écrire son état
 * (cookies, session à reprendre, « fermé correctement »). Renvoie true si la commande est partie.
 */
async function closeChromeViaCdp(timeoutMs = 4000) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: timeoutMs });
    const s = await browser.newBrowserCDPSession();
    await Promise.race([s.send("Browser.close"), new Promise(r => setTimeout(r, timeoutMs))]);
    return true;
  } catch { return false; }
  finally { await browser?.close().catch(() => {}); }
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitGone(pids, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && pids.some(alive)) await new Promise(r => setTimeout(r, 300));
  return !pids.some(alive);
}

/**
 * Arrête le Chrome lancé par ce processus (bancs d'essai) : arrêt propre par le protocole si possible,
 * SIGTERM sinon (et SIGKILL en dernier recours). Renvoie une promesse à ATTENDRE ; un banc d'essai qui ne
 * l'attend pas n'est couvert par le filet « exit » que si killChromeOnExit() est vrai.
 */
let stopping = null;
export function stopLaunchedChrome({ waitMs = 6000 } = {}) {
  const pid = launchedPid;
  if (!pid) return Promise.resolve();
  if (stopping) return stopping;
  // `launchedPid` n'est oublié qu'une fois le processus parti : si un banc d'essai quitte sans attendre, le
  // filet « exit » (bancs seulement) le retrouve encore et lui envoie SIGTERM.
  stopping = (async () => {
    try {
      if (await closeChromeViaCdp() && await waitGone([pid], waitMs)) return;
      try { process.kill(pid, "SIGTERM"); } catch {}
      if (await waitGone([pid], 3000)) return;
      try { process.kill(pid, "SIGKILL"); } catch {}
    } finally {
      if (launchedPid === pid) launchedPid = null;
      stopping = null;
    }
  })();
  return stopping;
}

/** Réduit ou déplie la fenêtre Chrome qui contient l'onglet (protocole DevTools). Silencieux en cas d'échec. */
export async function setWindowState(page, state) {
  try {
    const s = await page.context().newCDPSession(page);
    const { windowId } = await s.send("Browser.getWindowForTarget");
    await s.send("Browser.setWindowBounds", { windowId, bounds: { windowState: state } });
    await s.detach().catch(() => {});
  } catch {}
}

/** Cibles DevTools de type onglet (« page ») — jamais les pages internes (service workers, extensions…). */
export async function listPageTargets() {
  const r = await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) return [];
  const list = await r.json().catch(() => null);
  return Array.isArray(list) ? list.filter(t => t?.type === "page" && t?.webSocketDebuggerUrl) : [];
}

/**
 * La cible répond-elle à un Runtime.evaluate trivial en moins de `timeoutMs` ? C'est ce test, pas la simple
 * présence dans /json/list, qui distingue un onglet figé (boucle JS bloquante, rend son thread renderer —
 * et donc sa session DevTools — injoignable) d'un onglet normal. Node ≥ 22 seulement (WebSocket global) :
 * sur un Node plus ancien, on considère la cible répondante (rien à fermer) plutôt que de planter.
 */
export function targetResponsive(target, timeoutMs = 2000) {
  if (typeof WebSocket === "undefined") return Promise.resolve(true);
  return new Promise(resolve => {
    let done = false;
    let ws;
    const finish = ok => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      // Pas d'en-tête Origin explicite : Chrome DevTools refuse parfois une origine inattendue (« Rejected an
      // incoming WebSocket connection from the … origin »), et le WebSocket global de Node n'en envoie pas.
      ws = new WebSocket(target.webSocketDebuggerUrl);
    } catch { finish(false); return; }
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1", returnByValue: true } })); }
      catch { finish(false); }
    };
    ws.onmessage = ev => {
      try { finish(JSON.parse(ev.data)?.id === 1); } catch { finish(false); }
    };
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
}

/** Cibles « page » qui ne répondent pas au sondage ci-dessus (onglets figés, candidats à la fermeture). */
export async function findFrozenTargets(timeoutMs = 2000) {
  let targets;
  try { targets = await listPageTargets(); } catch { return []; }
  const frozen = [];
  for (const t of targets) if (!(await targetResponsive(t, timeoutMs))) frozen.push(t);
  return frozen;
}

/** Ferme une cible par le protocole DevTools (jamais le processus Chrome). */
async function closeTarget(id) {
  try { await fetch(`${CDP_URL}/json/close/${id}`, { signal: AbortSignal.timeout(3000) }); return true; } catch { return false; }
}

/** Ferme tous les onglets figés trouvés et journalise chacun. Renvoie le nombre fermé. */
async function closeFrozenTabs(onEvent) {
  const frozen = await findFrozenTargets();
  let closed = 0;
  for (const t of frozen) {
    if (await closeTarget(t.id)) {
      closed++;
      onEvent({ result: "étape", detail: `onglet figé fermé : ${publicUrl(t.url || "") || t.id}` });
    }
  }
  return closed;
}

/** PID des processus Chrome lancés sur le profil Sésame (jamais le Chrome habituel de l'utilisateur). */
const sesameChromePids = () => chromePidsOnProfile(CHROME_PROFILE);

/**
 * Arrête tous les processus Chrome Sésame : d'abord un arrêt PROPRE par le protocole (Browser.close, ≤ 8 s
 * pour que les processus disparaissent — Chrome écrit alors cookies et session à reprendre), puis seulement
 * SIGTERM, puis SIGKILL après `waitMs`.
 */
export async function killSesameChrome(waitMs = 8000) {
  if (sesameChromePids().length === 0) return;
  if (await closeChromeViaCdp()) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && sesameChromePids().length) await new Promise(r => setTimeout(r, 300));
    if (sesameChromePids().length === 0) { launchedPid = null; return; }
  }
  for (const pid of sesameChromePids()) { try { process.kill(pid, "SIGTERM"); } catch {} }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && sesameChromePids().length) await new Promise(r => setTimeout(r, 300));
  for (const pid of sesameChromePids()) { try { process.kill(pid, "SIGKILL"); } catch {} }
  launchedPid = null;
}

const errCause = e => String(e?.message || e).split("\n")[0];

/**
 * @param {{onEvent?: (e:{result?:string, detail:string}) => void}} [o] rapporte au journal ce qui se passe
 * (lancement, onglets figés fermés, redémarrage, échec final avec sa raison)
 */
export async function connect({ onEvent = () => {} } = {}) {
  // Chrome Sésame fermé : on le lance nous-mêmes (l'utilisateur n'a pas à passer par un terminal).
  let justLaunched = false;
  const state = await cdpProbe();
  if (state === "foreign") {
    onEvent({ result: "échec", detail: `port ${CDP_URL} occupé par un autre programme` });
    throw new Error(`Un autre programme occupe ${CDP_URL} : ce n'est pas le Chrome Sésame. Ferme-le, ou change le port (SESAME_CDP_URL).`);
  }
  if (state === "down") {
    onEvent({ result: "étape", detail: "Chrome Sésame fermé — lancement automatique" });
    const up = await launchChrome({ onEvent });
    if (!up) {
      onEvent({ result: "échec", detail: `Chrome Sésame ne répond pas sur ${CDP_URL} après lancement` });
      throw new Error(`Chrome Sésame ne répond pas sur ${CDP_URL} après lancement. Vérifie qu'un autre Chrome n'occupe pas le port.`);
    }
    justLaunched = true;
  }

  const tryAttach = async () => {
    try { return { browser: await chromium.connectOverCDP(CDP_URL, { timeout: 15000 }) }; }
    catch (e) { return { error: e }; }
  };

  let attempt = await tryAttach();

  // Chrome tourne mais n'a plus aucun onglet (dernière fenêtre fermée) : le protocole refuse la connexion.
  // On ouvre un onglet vide par l'API DevTools et on réessaie une fois.
  if (attempt.error && /context management is not supported/i.test(String(attempt.error.message))) {
    try {
      await fetch(`${CDP_URL}/json/new?about:blank`, { method: "PUT" });
      await new Promise(r => setTimeout(r, 800));
      attempt = await tryAttach();
    } catch {}
  }

  // Chrome répond sur le port (cdpProbe a dit « up ») mais l'attache Playwright expire quand même : un
  // onglet figé (Crédit Mutuel, Sonnette…) bloque le protocole DevTools sur TOUTES les cibles. On ferme
  // ceux qui ne répondent pas à un sondage trivial, puis on retente.
  if (attempt.error) {
    onEvent({ result: "étape", detail: "attache à Chrome expirée — recherche d'un onglet figé" });
    const closed = await closeFrozenTabs(onEvent);
    if (closed > 0) attempt = await tryAttach();
  }

  // Dernier recours : l'attache échoue encore alors que le port répond. On redémarre le Chrome Sésame — les
  // sessions ouvertes survivent (cookies sur disque) — et on retente une dernière fois.
  if (attempt.error) {
    onEvent({ result: "étape", detail: "attache toujours impossible — redémarrage du Chrome Sésame" });
    await killSesameChrome();
    const up = await launchChrome({ onEvent });
    if (up) {
      onEvent({ result: "étape", detail: "Chrome Sésame redémarré (attache impossible)" });
      justLaunched = true;
      attempt = await tryAttach();
    }
  }

  if (attempt.browser) {
    // Lancé par Sésame : la fenêtre part réduite dans le Dock. Elle ne se dépliera que pour un code à saisir.
    if (justLaunched) for (const p of allPages(attempt.browser)) await setWindowState(p, "minimized");
    return attempt.browser;
  }

  const cause = attempt.error ? errCause(attempt.error) : "raison inconnue";
  onEvent({ result: "échec", detail: `attache à Chrome impossible sur ${CDP_URL} (${cause})` });
  throw new Error(`Chrome répond sur ${CDP_URL} mais Playwright n'a pas pu s'y attacher, même après avoir fermé les onglets figés et redémarré Chrome Sésame (${cause}).`);
}

export function allPages(browser) {
  return browser.contexts().flatMap(c => c.pages());
}

/** URL sans paramètres ni fragment : ce qui peut être journalisé ou renvoyé à l'IA (jamais un code OAuth ou un lien magique). */
export function publicUrl(u) {
  try {
    const x = new URL(u);
    // about:blank, data:, chrome:// … : pas d'origine (« null ») — on rend le schéma et le chemin tels quels.
    return x.origin === "null" ? `${x.protocol}${x.pathname}`.slice(0, 120) : x.origin + x.pathname;
  } catch { return String(u || "").split(/[?#]/)[0]; }
}

/** Une frame peut-elle recevoir des identifiants du site ? Frame principale, même site, ou frame vide héritant d'un parent autorisé. */
export function frameAllowed(site, frame) {
  if (!frame) return false;
  const page = frame.page();
  if (frame === page.mainFrame()) return true;
  const url = frame.url() || "";
  if (siteMatchesUrl(site, url)) return true;
  if (url === "" || url === "about:blank" || url === "about:srcdoc") return frameAllowed(site, frame.parentFrame());
  return false;
}

/** L'onglet (et la frame visée) sont-ils toujours sur le site ? Vérifié juste avant chaque frappe. */
export function onSite(page, site, frame) {
  if (page.isClosed()) return false;
  if (!siteMatchesUrl(site, page.url())) return false;
  return frame ? frameAllowed(site, frame) : true;
}

/** Trouve l'onglet correspondant au site (le plus récent d'abord), sinon null. */
export async function findPage(browser, site) {
  const pages = allPages(browser).filter(p => siteMatchesUrl(site, p.url()));
  if (pages.length === 0) return null;
  // On préfère un onglet qui montre un champ mot de passe, puis un champ identifiant plausible, puis un
  // onglet déjà à l'étape code (2e facteur) : utile à sesame_wait_code même si fillLogin n'a pas été
  // appelé dans cette même session (l'onglet peut être sur un extraDomain, siteMatchesUrl les couvre déjà).
  for (const p of pages.slice().reverse()) if (await firstVisible(p, PASS_SELECTORS)) return p;
  for (const p of pages.slice().reverse()) if (await locateUser(p, site)) return p;
  for (const p of pages.slice().reverse()) if (await detectSecondFactor(p, site)) return p;
  return pages[pages.length - 1];
}

/**
 * L'onglet UNIQUE de ce site dans le Chrome Sésame. Règle du produit : un seul onglet par site, jamais deux.
 * Garde le plus pertinent (même préférence que `findPage` : mot de passe, puis identifiant, puis étape code)
 * et FERME les autres onglets du même site — sinon chaque connexion en laissait un de plus derrière elle.
 * N'ouvre jamais rien : renvoie null si le site n'a aucun onglet (à l'appelant d'appeler `openPage`).
 */
export async function claimSiteTab(browser, site, { onEvent = () => {} } = {}) {
  const matching = allPages(browser).filter(p => !p.isClosed() && siteMatchesUrl(site, p.url()));
  if (matching.length === 0) return null;
  const keep = (await findPage(browser, site)) || matching[matching.length - 1];
  const extras = matching.filter(p => p !== keep && !p.isClosed());
  for (const p of extras) await p.close().catch(() => {});
  if (extras.length) {
    onEvent({ result: "étape", detail: `${extras.length} onglet(s) en double fermé(s) pour « ${site.key} » — un seul onglet par site` });
  }
  return keep.isClosed() ? null : keep;
}

/**
 * Le bouton « se connecter avec <fournisseur> » sur cette page, s'il y est. `which` limite la recherche à un
 * fournisseur ; sans lui, on les essaie tous et on renvoie le premier trouvé.
 * Renvoie { hit, provider } ou null.
 */
async function findProviderButton(page, site, which) {
  if (page.isClosed()) return null;
  if (site.selectors?.providerSel) {
    const hit = await locate(page, site, site.selectors.providerSel, []);
    if (hit) return { hit, provider: which || site.authProvider || "google" };
  }
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (which && name !== which) continue;
    const hit = await findClickableByText(page, site, p.re, LOGIN_ENTRY_EXCLUDE_RE);
    if (hit) return { hit, provider: name };
  }
  return null;
}

// --- Chez le fournisseur : choix du compte, par CLIC seulement ---------------------------------------------
// Les pages de compte du fournisseur déclaré (PROVIDER_HOSTS, src/config.js) sont implicitement permises pour
// CLIQUER, sans extraDomains. Rien n'y est jamais tapé : ni fill, ni type, ni touche. Un écran de consentement
// n'est pas cliqué non plus : c'est à l'utilisateur de le donner une fois.
const EMAIL_SRC = "[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\\.[a-z]{2,}";
const CONSENT_TEXT_RE = /souhaite acc[ée]der|veut acc[ée]der|wants to access|would like to access|permissions? requested|autorisations? demand[ée]es?|will be able to|pourra\s|partager (vos|votre)|share your|authorize\s|autoriser\s.*acc[ée]der|allow .* to access/i;
const CONSENT_BTN_RE = /^(continuer|continue|autoriser|allow|accepter|accept|authorize|j'accepte|i agree|accept all)$/i;

/**
 * Tuiles de comptes de la page courante (sélecteur de comptes Google : `[data-identifier]` / `li[data-email]` ;
 * Microsoft : tuile `[data-test-id=e-mail]`) ou, à défaut, tout élément cliquable qui montre UNE adresse e-mail.
 * Chaque tuile reçoit un repère `data-sesame-tile` pour être cliquée ensuite. Renvoie [{ idx, email }] (minuscules).
 */
async function listAccountTiles(page) {
  return page.evaluate(({ EMAIL }) => {
    const visible = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
    document.querySelectorAll("[data-sesame-tile]").forEach(e => e.removeAttribute("data-sesame-tile"));
    const out = [], seen = new Set();
    const els = document.querySelectorAll('[data-identifier], [data-email], [data-test-id], li, a, button, [role="button"], [role="link"], [role="option"], [role="listitem"]');
    for (const e of els) {
      if (!visible(e)) continue;
      const attr = e.getAttribute("data-identifier") || e.getAttribute("data-email") || e.getAttribute("data-test-id") || "";
      let email = attr.includes("@") ? attr : null;
      if (!email) {
        const found = ((e.innerText || e.textContent || "").match(new RegExp(EMAIL, "gi"))) || [];
        if (new Set(found.map(x => x.toLowerCase())).size !== 1) continue;   // aucune adresse, ou un conteneur de plusieurs comptes
        email = found[0];
      }
      email = email.trim().toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      e.setAttribute("data-sesame-tile", String(out.length));
      out.push({ idx: out.length, email });
    }
    return out;
  }, { EMAIL: EMAIL_SRC }).catch(() => []);
}

/** La page demande-t-elle un consentement (accès de l'application au compte) ? Texte explicite, ou bouton « Continuer / Accepter ». */
async function looksLikeConsent(page) {
  const body = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  if (CONSENT_TEXT_RE.test(body)) return true;
  const labels = await page.locator('button, [role="button"], input[type="submit"]')
    .evaluateAll(els => els.filter(e => !!(e.offsetWidth || e.offsetHeight)).map(e => (e.innerText || e.value || "").trim())).catch(() => []);
  return labels.some(l => CONSENT_BTN_RE.test(l));
}

/**
 * Après le clic du bouton fournisseur : tant que la page (ou la fenêtre qui s'est ouverte) est chez le fournisseur
 * déclaré, clique la tuile du compte `account` s'il y a un sélecteur de comptes. Ne tape rien. Renvoie
 *  - { stop: { reason } } : Sésame s'arrête (compte absent, plusieurs comptes sans `account`, consentement) ;
 *  - { stop: null } : plus de choix à faire (revenu sur le site, fenêtre fermée, ou écran inconnu).
 * `getCur()` rend la page du fournisseur courante (la fenêtre si une s'est ouverte, sinon l'onglet).
 */
async function chooseProviderAccount({ site, label, getCur, step }) {
  const account = normalizeAccount(site.account);
  let clicked = false;
  for (let round = 0; round < 4; round++) {
    const cur = getCur();
    if (!cur || cur.isClosed() || !isProviderUrl(site.authProvider, cur.url())) return { stop: null };
    const where = publicUrl(cur.url());
    const tiles = await listAccountTiles(cur);
    if (tiles.length) {
      if (clicked) {
        // Le sélecteur de comptes réapparaît après notre clic : le fournisseur refuse ou redemande, on n'insiste pas.
        return { stop: { reason: `${label} montre encore le choix du compte après le clic sur ${account || "la tuile"} (${where}) : intervention de l'utilisateur nécessaire.` } };
      }
      let tile;
      if (account) {
        tile = tiles.find(x => x.email === account);
        if (!tile) {
          step(`sélecteur de comptes ${label} : ${tiles.length} compte(s) proposé(s), « ${account} » absent — aucun clic`);
          return { stop: { reason: `compte ${account} introuvable parmi les ${tiles.length} proposé(s) par ${label} (${where}) : l'utilisateur doit s'y connecter une fois, ou corriger le champ Compte du site.` } };
        }
      } else if (tiles.length === 1) {
        tile = tiles[0];
      } else {
        step(`sélecteur de comptes ${label} : ${tiles.length} comptes proposés et aucun compte déclaré pour « ${site.key} » — aucun clic`);
        return { stop: { reason: `${label} propose ${tiles.length} comptes et aucun compte (e-mail) n'est déclaré pour « ${site.key} » : renseigne le champ Compte du site dans l'app Sésame.` } };
      }
      step(`sélecteur de comptes ${label} : ${tiles.length} compte(s) proposé(s), tuile « ${tile.email} » à cliquer`);
      await cur.locator(`[data-sesame-tile="${tile.idx}"]`).first().click({ timeout: 5000 }).catch(() => {});
      clicked = true;
      step(`compte « ${tile.email} » choisi chez ${label} (clic)`);
      // Laisser le fournisseur rendre la main : la page quitte son domaine (ou la fenêtre se ferme).
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const c = getCur();
        if (!c || c.isClosed() || !isProviderUrl(site.authProvider, c.url())) break;
        await cur.waitForTimeout(400).catch(() => {});
      }
      await cur.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      continue;
    }
    if (await looksLikeConsent(cur)) {
      step(`écran de consentement ${label} (${where}) — non cliqué`);
      return { stop: { reason: `consentement à donner une fois par Sam : ${label} demande d'autoriser « ${site.key} » (${where}). Sésame ne clique jamais un consentement ; une fois donné, la connexion suivante passera seule.` } };
    }
    return { stop: null };   // écran inconnu (mot de passe, code, vérification…) : traité comme « le fournisseur demande quelque chose »
  }
  return { stop: null };
}

/**
 * Aucun champ visible : le formulaire est peut-être caché derrière une entrée (« Se connecter »,
 * « ESPACE PRIVÉ »…). Clique CETTE entrée une seule fois, puis laisse l'appelant relocaliser les champs.
 * Ne clique jamais une création de compte ni une déconnexion. Renvoie true si un clic a eu lieu.
 */
async function openLoginForm(page, site, steps) {
  if (page.isClosed()) return false;
  const sel = site.selectors?.openFormSel;
  const hit = sel ? await locate(page, site, sel, []) : await findClickableByText(page, site, LOGIN_ENTRY_RE, LOGIN_ENTRY_EXCLUDE_RE);
  if (!hit || !onSite(page, site, hit.frame)) return false;
  await hit.el.click({ timeout: 5000 }).catch(() => {});
  steps.push("entrée « se connecter » cliquée pour faire apparaître le formulaire");
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return true;
}

/** Un champ mot de passe (sélecteur du site ou générique) est-il visible sur l'onglet ? */
export async function hasPasswordField(page, site) {
  if (page.isClosed()) return false;
  return !!(await locate(page, site, site.selectors?.password, PASS_SELECTORS));
}

/** L'onglet montre-t-il un formulaire de connexion (identifiant ou mot de passe), ou un écran « session déjà
 *  ouverte / choix de compte » (bouton « continuer avec ce compte », lien « changer de compte ») ? */
export async function hasLoginFields(page, site) {
  if (page.isClosed()) return false;
  if (await locate(page, site, site.selectors?.password, PASS_SELECTORS)) return true;
  if (await locateUser(page, site)) return true;
  return !!(await detectAccountScreen(page, site));
}

/**
 * La page montre-t-elle une session DÉJÀ OUVERTE ? Signe retenu : elle propose de se déconnecter (texte
 * cliquable, ou lien dont l'adresse mène à la déconnexion), alors qu'aucun champ de connexion n'est visible.
 * C'est le cas le plus courant : le site redirige la page de connexion vers son tableau de bord. Sans ce
 * test, Sésame répondait « aucun champ identifiant/mot de passe visible » — un échec, alors que tout va bien.
 */
export async function looksSignedIn(page, site) {
  if (page.isClosed()) return false;
  // 1. La page offre de se déconnecter : signe direct, quand il est là.
  if (await findClickableByText(page, site, SIGNED_IN_TEXT_RE)) return true;
  try {
    const hrefs = await page.locator("a[href]").evaluateAll(els =>
      els.slice(0, 300).filter(e => !!(e.offsetWidth || e.offsetHeight)).map(e => e.getAttribute("href") || ""));
    if (hrefs.some(h => SIGNED_IN_HREF_RE.test(h))) return true;
  } catch {}
  // 2. Beaucoup d'applications modernes ne rendent leur bouton « Déconnexion » qu'une fois le menu du
  //    compte ouvert : rien à trouver dans la page (constaté sur le tableau de bord Cloudflare). Signe
  //    retenu alors : le site nous a DÉPLACÉS de sa page de connexion vers une de ses pages internes
  //    (Cloudflare : /login → /<compte>/home). Une redirection vers la racine, elle, est le renvoi
  //    habituel d'un visiteur NON connecté (E.Leclerc : /ma-carte → /), et ne compte pas.
  try {
    const from = new URL(site.loginUrl || `https://${site.domain}/`);
    const now = new URL(page.url());
    const norm = x => x.replace(/\/+$/, "") || "/";
    // Applications à une seule page (Sonnette : /#/planning) : le chemin ne bouge pas, seule l'ancre change.
    // Une ancre de route différente de celle de la page de connexion vaut donc « page interne ».
    const route = h => (/^#\/?.+/.test(h) ? norm(h.replace(/^#\/?/, "/")) : "");
    const hereHash = route(now.hash), fromHash = route(from.hash);
    if (hereHash && hereHash !== fromHash) return true;
    const here = norm(now.pathname);
    // Une page de connexion, d'erreur ou de déconnexion ne prouve jamais rien.
    if (/log-?in|log-?out|sign-?in|sign-?up|auth|connexion|deconnexion|erreur|error|404|not-?found/i.test(here)) return false;
    // Hôte qui n'existe que pour les personnes connectées (dashboard.render.com, manager.ovhcloud.com) :
    // y arriver sans formulaire de connexion, c'est y être connecté — même à la racine.
    if (/^(dashboard|dash|app|admin|manager|manage|my|mon|portal|portail|console|espace|account|compte|client)\./i.test(now.hostname)) return true;
    if (here === "/" || here === norm(from.pathname)) return false;
    return true;
  } catch { return false; }
}

/** Ramène un onglet du site sur sa page de connexion (session déjà ouverte, tableau de bord, page de déconnexion…). */
export async function gotoLogin(page, url, site) {
  // Certains liens de connexion déconnectent d'abord (page « vous êtes déconnecté ») et n'affichent le
  // formulaire qu'au passage suivant : on y retourne jusqu'à trois fois tant qu'aucun champ n'apparaît.
  for (let i = 0; i < 3; i++) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);
    if (!site || await hasLoginFields(page, site)) return true;
    // Le site renvoie sur son tableau de bord : la session est déjà ouverte, insister n'apporterait rien.
    if (site && await looksSignedIn(page, site)) return false;
  }
  return false;
}

export async function openPage(browser, url) {
  const ctx = browser.contexts()[0] || await browser.newContext();
  // Réutiliser un onglet vide (celui du lancement, ou un « nouvel onglet ») plutôt que créer une cible :
  // par le protocole DevTools, Chrome ouvre volontiers une nouvelle cible dans une fenêtre séparée.
  const blank = ctx.pages().find(p => /^(about:blank|chrome:\/\/newtab)/.test(p.url() || ""));
  const page = blank || await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  return page;
}

async function firstVisible(page, selectors, root = page) {
  for (const sel of selectors) {
    const loc = root.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false) && await el.isEditable().catch(() => true) && !(await ressembleAUneRecherche(el))) return el;
    }
  }
  return null;
}

/** Le champ de recherche du site (en-tête d'un grand écran) n'est jamais un identifiant. */
async function ressembleAUneRecherche(el) {
  return el.evaluate(e => {
    if (e.tagName !== "INPUT") return false;
    if ((e.type || "").toLowerCase() === "search") return true;
    const t = [e.name, e.id, e.placeholder, e.getAttribute("aria-label"), e.getAttribute("autocomplete"), e.className]
      .filter(Boolean).join(" ").toLowerCase();
    return /search|recherch|cherch|suche|\bq\b/.test(t) || !!e.closest("form[role=search], [role=search]");
  }).catch(() => false);
}

/** Cherche dans la frame principale puis dans les iframes AUTORISÉES (même site). Renvoie { el, frame } ou null. */
async function locate(page, site, custom, fallbacks) {
  const sels = custom ? [custom] : fallbacks;
  if (page.isClosed()) return null;
  let el = await firstVisible(page, sels);
  if (el) return { el, frame: page.mainFrame() };
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || !frameAllowed(site, frame)) continue;
    el = await firstVisible(page, sels, frame);
    if (el) return { el, frame };
  }
  return null;
}

/** Champ identifiant plausible : sélecteur du site, champ fort, ou champ faible sur la page de connexion / près d'un mot de passe. */
/** L'adresse ou le titre annoncent-ils une page de connexion ? Sert à accepter un simple champ texte
 *  (sans nom ni identifiant HTML) quand le site redirige vers son propre service d'identité : Apple envoie
 *  reportaproblem.apple.com sur idmsa.apple.com/IDMSWebAuth/signin, dont le champ n'a ni name ni id. */
const LOGIN_PAGE_RE = /log-?in|sign-?in|signin|connexion|se-connecter|identifi|authent|\bauth\b|idms|\bsso\b|\bidp\b/i;
async function looksLikeLoginPage(page) {
  try {
    const u = new URL(page.url());
    if (LOGIN_PAGE_RE.test(u.pathname) || LOGIN_PAGE_RE.test(u.hostname)) return true;
  } catch {}
  const title = await page.title().catch(() => "");
  return /connexion|se connecter|sign in|log in|login|identification|identifiez-vous/i.test(title);
}

async function locateUser(page, site) {
  if (site.selectors?.username) return locate(page, site, site.selectors.username, []);
  const strong = await locate(page, site, null, USER_STRONG);
  if (strong) return strong;
  // Un champ texte nu n'est accepté que si la page est bien une page de connexion : celle déclarée pour le
  // site, une page dont l'adresse ou le titre l'annoncent, ou une page qui montre déjà un mot de passe.
  // Sans ce garde-fou, le champ d'une inscription à une lettre d'information passerait pour un identifiant.
  const onDeclaredLoginPage = site.loginUrl && hostnameOf(page.url()) === hostnameOf(site.loginUrl);
  const nearPassword = !!(await locate(page, site, site.selectors?.password, PASS_SELECTORS));
  if (onDeclaredLoginPage || nearPassword || await looksLikeLoginPage(page)) return locate(page, site, null, USER_WEAK);
  return null;
}

/** Élément cliquable (bouton, lien…) dont le texte visible correspond à `re`, jamais un dont le texte
 *  correspond à `excludeRe` (ex. un bouton de déconnexion). Cherche la frame principale puis les iframes
 *  autorisées, comme `locate`. */
async function findClickableByText(page, site, re, excludeRe) {
  const build = root => root.locator(ACCOUNT_CLICKABLE).filter({ hasText: re });
  const scan = async root => {
    const loc = build(root);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 20); i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const text = (await el.innerText().catch(() => "")) || "";
      if (excludeRe && excludeRe.test(text)) continue;
      return el;
    }
    return null;
  };
  let el = await scan(page);
  if (el) return { el, frame: page.mainFrame() };
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || !frameAllowed(site, frame)) continue;
    el = await scan(frame);
    if (el) return { el, frame };
  }
  return null;
}

/** Texte de l'élément qui affiche le compte connecté (sélecteur du site), ou tout le texte visible de la page
 *  si aucun sélecteur n'est fourni (détection générique). */
async function accountDisplayText(page, site) {
  if (site.selectors?.accountSel) {
    const hit = await locate(page, site, site.selectors.accountSel, []);
    return hit ? (await hit.el.innerText().catch(() => "")) || "" : "";
  }
  return await page.evaluate(() => document.body?.innerText || "").catch(() => "");
}

/** Sous-chaînes qui ressemblent à une adresse e-mail (en clair ou masquée) dans un texte. */
function findAccountCandidates(text) {
  if (!text) return [];
  const seen = new Set();
  for (const m of String(text).matchAll(EMAIL_CANDIDATE_RE)) seen.add(m[0].toLowerCase());
  return [...seen];
}

/** Un candidat affiché (en clair ou masqué, ex. « j***@exemple.fr ») désigne-t-il l'identifiant enregistré ?
 *  Comparaison insensible à la casse ; un candidat masqué doit avoir le même domaine et un préfixe local qui
 *  est le début de l'identifiant réel. */
function accountMatches(candidate, username) {
  if (!candidate || !username) return false;
  const cand = String(candidate).trim().toLowerCase();
  const uname = String(username).trim().toLowerCase();
  if (!uname) return false;
  if (cand === uname) return true;
  const um = uname.match(/^([^@]+)@(.+)$/);
  const cm = cand.match(/^([^@]+)@(.+)$/);
  if (!um || !cm) return false;
  const [, local, domain] = um;
  const [, candLocal, candDomain] = cm;
  if (candDomain !== domain) return false;
  if (candLocal === local) return true;
  const bare = candLocal.replace(/[*•.…]+$/, ""); // partie visible avant le masquage
  return bare.length >= 1 && local.startsWith(bare);
}

/**
 * Écran « session déjà ouverte / choix de compte » (ex. Orange keep-connected) : un bouton pour continuer avec
 * le compte affiché et/ou un lien pour en changer. Renvoie null si ni l'un ni l'autre n'est présent (page de
 * connexion classique) ; sinon { continueHit, switchHit, accountText }.
 */
async function detectAccountScreen(page, site) {
  if (page.isClosed()) return null;
  const continueHit = site.selectors?.continueSel
    ? await locate(page, site, site.selectors.continueSel, [])
    : await findClickableByText(page, site, CONTINUE_TEXT_RE, LOGOUT_TEXT_RE);
  const switchHit = site.selectors?.switchAccountSel
    ? await locate(page, site, site.selectors.switchAccountSel, [])
    : await findClickableByText(page, site, SWITCH_TEXT_RE, LOGOUT_TEXT_RE);
  if (!continueHit && !switchHit) return null;
  return { continueHit, switchHit, accountText: await accountDisplayText(page, site) };
}

/**
 * Gère un écran repéré par `detectAccountScreen` : clique « continuer avec ce compte » quand le compte
 * affiché correspond à l'identifiant enregistré (ou qu'aucun compte identifiable n'est affiché), sinon clique
 * « changer de compte » quand un compte différent est affiché. Ne clique jamais un bouton de déconnexion
 * (déjà écarté par `findClickableByText`). Renvoie :
 *  - null si l'écran n'a ni bouton « continuer » ni lien « changer de compte » ;
 *  - { finished: true, result } quand il faut renvoyer `result` directement à l'appelant (succès
 *    `alreadySignedIn`, ou abandon hors périmètre) ;
 *  - { finished: false } après un clic, quand l'appelant doit relocaliser les champs du formulaire.
 */
async function tryAccountScreen(page, site, secret, steps, bail) {
  const screen = await detectAccountScreen(page, site);
  if (!screen) return null;
  const { continueHit, switchHit, accountText } = screen;
  const candidates = findAccountCandidates(accountText);
  const identifiable = candidates.length > 0;
  const matches = secret.username ? candidates.some(c => accountMatches(c, secret.username)) : false;
  const mismatch = identifiable && !!secret.username && !matches; // un AUTRE compte, reconnaissable, est affiché
  const preferContinue = !!continueHit && !mismatch;

  const clickAndSettle = async (hit, label) => {
    if (!onSite(page, site, hit.frame)) return { finished: true, result: await bail() };
    await hit.el.click({ timeout: 5000 }).catch(() => {});
    steps.push(label);
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    return null;
  };

  if (preferContinue) {
    const stopped = await clickAndSettle(continueHit, "session déjà ouverte : « Continuer avec ce compte » cliqué");
    if (stopped) return stopped;
    if (page.isClosed()) return { finished: true, result: await bail() };
    const pass2 = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
    const user2 = secret.username ? await locateUser(page, site) : null;
    if (pass2 || user2) return { finished: false }; // un formulaire a suivi : suite du remplissage normal
    // Laisser la navigation qui suit le clic se terminer, pour rendre l'URL d'arrivée (tableau de bord).
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    return {
      finished: true,
      result: coded("ok.already_signed_in", {
        ok: true, steps, url: publicUrl(page.url()), title: await page.title().catch(() => ""),
        alreadySignedIn: true,
      }, { confidence: await aliveSelVisible(page, site) ? "high" : "medium" }),
    };
  }

  if (switchHit) {
    const stopped = await clickAndSettle(switchHit, "session déjà ouverte : compte différent → « Changer de compte » cliqué");
    if (stopped) return stopped;
    return { finished: false };
  }

  return null;
}

/**
 * Saisit un code à usage unique. Beaucoup de sites (Booking) le présentent en cases séparées, une par
 * chiffre : `fill()` mettrait tout dans la première et le composant le rejetterait. On clique alors la
 * première case et on tape au clavier, le composant passe seul d'une case à l'autre.
 */
async function typeCode(page, el, code) {
  const cases = await el.evaluateHandle(n => {
    const zone = n.closest("form") || n.parentElement?.parentElement || document;
    return [...zone.querySelectorAll("input")].filter(i => i.type !== "hidden" && i.offsetParent !== null
      && (i.maxLength === 1 || /^(code|otp|digit|pin)[-_]?\d+$/i.test(i.name || i.id || "")));
  }).catch(() => null);
  const n = cases ? await cases.evaluate(l => l.length).catch(() => 0) : 0;
  const chiffres = String(code);
  // Diagnostic sans le code lui-même : seulement les longueurs (journal du moteur).
  console.error(`[sesame] code à usage unique : ${chiffres.length} chiffres, ${n} case(s)`);
  if (n >= 4 && n === chiffres.length) {
    // Une case par chiffre : on clique chaque case et on tape son chiffre, sans compter sur le passage
    // automatique d'une case à l'autre (il perd des touches quand le composant est lent).
    for (let i = 0; i < n; i++) {
      const c = await cases.evaluateHandle((l, i) => l[i], i);
      await c.asElement().click({ timeout: 5000 }).catch(() => {});
      await page.keyboard.type(chiffres[i], { delay: 60 });
      await page.waitForTimeout(120);
    }
    // Vérification : une case restée vide ou fausse est reprise par remplissage direct.
    const vals = await cases.evaluate(l => l.map(i => i.value)).catch(() => null);
    if (vals) {
      for (let i = 0; i < n; i++) {
        if (vals[i] === chiffres[i]) continue;
        const c = await cases.evaluateHandle((l, i) => l[i], i);
        await c.asElement().click({ timeout: 5000 }).catch(() => {});
        await c.asElement().fill(chiffres[i], { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(120);
      }
      const manque = await cases.evaluate((l, c) => l.filter((i, k) => i.value !== c[k]).length, chiffres).catch(() => -1);
      console.error(`[sesame] code à usage unique : ${manque} case(s) non conforme(s) après saisie`);
    }
    return;
  }
  if (n >= 4) {
    await el.click({ timeout: 5000 }).catch(() => {});
    await page.keyboard.type(chiffres, { delay: 120 });
    return;
  }
  await typeInto(el, code);
}

async function typeInto(el, value) {
  const clique = await el.click({ timeout: 5000 }).then(() => true).catch(() => false);
  await el.fill("", { timeout: 5000 }).catch(() => {});
  // Un mot de passe se tape touche par touche, comme une personne, quand le champ a bien reçu le
  // clic : certains formulaires (Booking, page partenaire) ignorent une valeur posée d'un bloc.
  // Sinon, et pour tout le reste, `fill` (fiable, ne dépend pas du focus).
  const type = await el.getAttribute("type").catch(() => "");
  const page = typeof el.page === "function" ? el.page() : null;
  if (clique && page && type === "password" && value.length <= 200) {
    await page.keyboard.type(value, { delay: 25 }).catch(() => {});
    const lu = await el.inputValue({ timeout: 2000 }).catch(() => null);
    if (lu === value) return;
    await el.fill("", { timeout: 5000 }).catch(() => {});
  }
  await el.fill(value, { timeout: 5000 });
}

/** Bandeau de cookies qui recouvre la page : on refuse (le choix le plus sobre) s'il y a un bouton pour ça. */
async function ecarterBandeauCookies(page) {
  const motifs = /^(continuer sans accepter|refuser( tout)?|tout refuser|decline( all)?|reject( all)?|alles ablehnen|ablehnen)$/i;
  for (const frame of [page, ...page.frames()]) {
    try {
      const boutons = frame.locator("button, a[role=button], [role=button]");
      const n = Math.min(await boutons.count(), 40);
      for (let i = 0; i < n; i++) {
        const b = boutons.nth(i);
        const t = ((await b.innerText({ timeout: 500 }).catch(() => "")) || "").trim();
        if (motifs.test(t) && await b.isVisible().catch(() => false)) {
          await b.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(500);
          return t;
        }
      }
    } catch { /* cadre fermé entre-temps */ }
  }
  return null;
}

// --- Cases « rester connecté / faire confiance à cet appareil » ------------------------------------------
const REMEMBER_RE = /rester connect|garder ma session|se souvenir|souviens|remember|keep me (logged|signed) in|stay (signed|logged) in|trust(ed)? (this )?(device|browser|computer)|faire confiance|appareil de confiance|navigateur de confiance|ne plus (me )?demander|don.t ask again|conserver la connexion|m[ée]moriser|rester identifi/i;
const REMEMBER_EXCLUDE_RE = /newsletter|offre|promo|marketing|actualit|cgu|cgv|conditions|terms|privacy|confidentialit|cookie|consent|accept|j.accepte|i agree|publicit|partenaire/i;

/**
 * Juste avant chaque soumission (étape 1, mot de passe, code) : coche la case « rester connecté » /
 * « faire confiance à cet appareil » si elle est là, pour que la session (et la confiance 2FA) survive au
 * redémarrage de Chrome. Cherche dans le <form> du champ, puis ses 6 ancêtres, une case visible et non
 * cochée dont le libellé (label[for], label parent, aria-label, aria-labelledby, texte du conteneur parent
 * ≤ 200 car.) correspond à REMEMBER_RE et pas à REMEMBER_EXCLUDE_RE (jamais une lettre d'information ni
 * des conditions). Clique le libellé (sinon la case), vérifie `checked`, ajoute une étape. Une seule case
 * par appel ; rien si site.rememberMe === false ; frame vérifiée par onSite ; aucune exception ne remonte.
 * `field` : { el, frame } (résultat de locate) ou un Locator. `mask` : valeurs (identifiant, mot de passe)
 * à ne jamais recopier dans l'étape : un libellé qui les contient (« Rester connecté en tant que x@y ») est
 * remplacé par « [masqué] », comme dans readFormError ; toute adresse e-mail est masquée de même.
 */
export async function tickRememberMe(page, site, field, steps = [], mask = []) {
  try {
    if (!field || site?.rememberMe === false || page.isClosed()) return false;
    const el = field.el || field;
    const frame = field.frame || page.mainFrame();
    if (!onSite(page, site, frame)) return false;
    const found = await el.evaluate((node, { pos, neg }) => {
      const POS = new RegExp(pos, "i"), NEG = new RegExp(neg, "i");
      const visible = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
      const clean = s => (s || "").replace(/\s+/g, " ").trim().slice(0, 200);
      const labelOf = cb => {
        const parts = [];
        if (cb.id) for (const l of document.querySelectorAll(`label[for="${CSS.escape(cb.id)}"]`)) parts.push(clean(l.innerText || l.textContent));
        const parent = cb.closest("label");
        if (parent) parts.push(clean(parent.innerText || parent.textContent));
        if (cb.getAttribute("aria-label")) parts.push(clean(cb.getAttribute("aria-label")));
        const by = cb.getAttribute("aria-labelledby");
        if (by) for (const id of by.split(/\s+/)) { const e = document.getElementById(id); if (e) parts.push(clean(e.innerText || e.textContent)); }
        if (!parts.filter(Boolean).length && cb.parentElement) parts.push(clean(cb.parentElement.innerText || cb.parentElement.textContent));
        return parts.filter(Boolean).join(" | ");
      };
      const roots = [];
      const form = node.closest("form");
      if (form) roots.push(form);
      let a = node;
      for (let i = 0; i < 6 && a && a.parentElement; i++) { a = a.parentElement; roots.push(a); }
      document.querySelectorAll("[data-sesame-remember]").forEach(e => e.removeAttribute("data-sesame-remember"));
      for (const root of roots) {
        for (const cb of root.querySelectorAll('input[type="checkbox"]')) {
          if (cb.checked || cb.disabled || !visible(cb)) continue;
          const label = labelOf(cb);
          if (!label || !POS.test(label) || NEG.test(label)) continue;
          cb.setAttribute("data-sesame-remember", "case");
          let target = null;
          if (cb.id) target = document.querySelector(`label[for="${CSS.escape(cb.id)}"]`);
          if (!target) target = cb.closest("label");
          if (target && visible(target)) target.setAttribute("data-sesame-remember", "libelle");
          return { label: label.slice(0, 80), viaLabel: !!(target && visible(target)) };
        }
      }
      return null;
    }, { pos: REMEMBER_RE.source, neg: REMEMBER_EXCLUDE_RE.source });
    if (!found) return false;
    const box = frame.locator('[data-sesame-remember="case"]').first();
    const target = found.viaLabel ? frame.locator('[data-sesame-remember="libelle"]').first() : box;
    await target.click({ timeout: 3000 }).catch(() => {});
    let checked = await box.isChecked().catch(() => false);
    if (!checked && found.viaLabel) { await box.click({ timeout: 3000 }).catch(() => {}); checked = await box.isChecked().catch(() => false); }
    if (!checked) { await box.evaluate(e => { e.click(); }).catch(() => {}); checked = await box.isChecked().catch(() => false); }
    await frame.evaluate(() => document.querySelectorAll("[data-sesame-remember]").forEach(e => e.removeAttribute("data-sesame-remember"))).catch(() => {});
    if (checked) steps.push(`case « rester connecté » cochée (« ${maskLabel(found.label, mask)} »)`);
    return checked;
  } catch { return false; }
}

/** Libellé sûr pour le journal : « [masqué] » s'il contient une valeur de `mask` (blancs normalisés) ou une adresse e-mail. */
function maskLabel(label, mask = []) {
  const norm = s => String(s || "").replace(/\s+/g, " ").trim();
  const text = norm(label);
  const flat = text.replace(/\s+/g, "");
  for (const v of mask) {
    const nv = norm(v);
    if (nv.length >= 3 && (text.includes(nv) || flat.includes(nv.replace(/\s+/g, "")))) return "[masqué]";
  }
  return text.replace(/[^\s«»()]+@[^\s«»()]+/g, "[masqué]");
}

// --- Classifieur après soumission --------------------------------------------------------------------------
// Frames de DÉFI (un captcha à résoudre), reconnues à leur adresse : la fenêtre d'images reCAPTCHA (/bframe),
// hCaptcha, Turnstile (Cloudflare), Arkose/FunCaptcha, AWS WAF, DataDome, PerimeterX. Jamais la simple ancre
// « api2/anchor » : c'est aussi le badge reCAPTCHA v3/invisible, chargé en permanence sur les pages de tout
// site qui utilise reCAPTCHA, même connecté — le compter faisait répondre « captcha » (et poser le verrou du
// jour) sur une session parfaitement vivante.
const CAPTCHA_CHALLENGE_RE = /\/bframe|hcaptcha\.com\/captcha|challenges\.cloudflare\.com\/.*\/(turnstile|challenge)|arkose|funcaptcha|captcha-delivery|awswaf|datadome|perimeterx/i;
// Ancre reCAPTCHA v2 (case « Je ne suis pas un robot ») : un défi seulement si elle est VISIBLE, de taille
// normale (≥ 200×60) et pas « invisible » (size=invisible, ou dans .grecaptcha-badge) — c'est l'utilisateur
// qui doit cocher la case, Sésame ne le fait pas.
const CAPTCHA_ANCHOR_RE = /recaptcha.*\/anchor/i;
const CAPTCHA_INVISIBLE_RE = /size=invisible/i;
// Texte visible d'un défi. Pas le mot « challenge » nu : il est dans n'importe quelle page anglaise et dans le
// tableau de bord Cloudflare (« Managed Challenge »), sans aucun captcha à l'écran.
const CAPTCHA_TEXT_RE = /captcha|je ne suis pas un robot|not a robot|v[ée]rifi\w* (que vous )?[êe]tes (bien )?humain|make sure you.re human|prove you.re human|verif\w* (that )?you are human|confirm (that )?you are human|just a moment/i;
// Mention passive du badge reCAPTCHA (« Ce site est protégé par reCAPTCHA… ») : présente sur la page de
// connexion AVANT toute soumission, elle ne signale aucun défi. Retirée du texte avant le test.
const CAPTCHA_BADGE_RE = /(this site is |ce site est |site )?prot[ée]g[ée]e? (by|par) recaptcha[^.\n]*|recaptcha[^.\n]{0,40}(privacy|confidentialit|terms|conditions)[^.\n]*/gi;

/**
 * Dans la page (ElementHandle.evaluate) : ce qu'il faut savoir d'une iframe pour juger si elle est un défi
 * effectivement À L'ÉCRAN — rectangle, présence dans la fenêtre, `visibility: hidden` / `display: none` /
 * `opacity: 0` sur l'élément ou l'un de ses ancêtres, ancêtre `.grecaptcha-badge`. Aucun eval dans la page
 * (les CSP strictes l'interdisent) : le jugement se fait côté Node (captchaFrameIsChallenge).
 */
const captchaFrameFacts = el => {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth, vh = window.innerHeight || document.documentElement.clientHeight;
  let hidden = false;
  for (let a = el, i = 0; a && i < 12; i++, a = a.parentElement) {
    const st = getComputedStyle(a);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) { hidden = true; break; }
  }
  return { w: r.width, h: r.height, onScreen: !(r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh), hidden, badge: !!el.closest(".grecaptcha-badge") };
};
/** Adresse de défi ou d'ancre reCAPTCHA ? (premier tri, avant de regarder l'élément) */
const captchaFrameUrl = s => CAPTCHA_CHALLENGE_RE.test(s) || CAPTCHA_ANCHOR_RE.test(s);
/**
 * Verdict pour une iframe d'adresse `src` et de faits `f` (captchaFrameFacts) : défi (CAPTCHA_CHALLENGE_RE)
 * d'au moins 200×100, ou ancre reCAPTCHA v2 d'au moins 200×60 hors badge et hors « invisible » — dans la
 * fenêtre et effectivement visible.
 */
function captchaFrameIsChallenge(src, f) {
  if (!f || f.hidden || !f.onScreen) return false;
  const s = String(src || "");
  if (CAPTCHA_CHALLENGE_RE.test(s)) return f.w >= 200 && f.h >= 100;
  if (CAPTCHA_ANCHOR_RE.test(s)) return !CAPTCHA_INVISIBLE_RE.test(s) && !f.badge && f.w >= 200 && f.h >= 60;
  return false;
}

/**
 * Un captcha ou une vérification humaine est-il à l'écran ? Vrai si une iframe de DÉFI effectivement visible
 * est là (captchaFrameIsChallenge : jamais le badge reCAPTCHA v3/invisible), ou si le texte visible (4000
 * premiers caractères du corps, mention passive « protégé par reCAPTCHA » retirée) correspond à
 * CAPTCHA_TEXT_RE. Ne lève jamais.
 */
export async function detectCaptcha(page) {
  if (!page || page.isClosed()) return false;
  try {
    // 1. Iframes du document principal, par leur attribut src (ou data-src).
    const srcs = await page.evaluate(() => [...document.querySelectorAll("iframe")].map(f => f.getAttribute("src") || f.getAttribute("data-src") || "")).catch(() => []);
    for (let i = 0; i < srcs.length; i++) {
      if (!captchaFrameUrl(srcs[i])) continue;
      const facts = await page.locator("iframe").nth(i).evaluate(captchaFrameFacts, null, { timeout: 1000 }).catch(() => null);
      if (captchaFrameIsChallenge(srcs[i], facts)) return true;
    }
    // 2. Frames dont l'adresse réelle (après redirections, ou posée par script) n'est pas dans l'attribut src.
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      const url = f.url() || "";
      if (!captchaFrameUrl(url)) continue;
      const owner = await f.frameElement().catch(() => null);
      if (!owner) continue;
      const facts = await owner.evaluate(captchaFrameFacts).catch(() => null);
      await owner.dispose().catch(() => {});
      if (captchaFrameIsChallenge(url, facts)) return true;
    }
    const body = await page.evaluate(() => (document.body?.innerText || "").slice(0, 4000)).catch(() => "");
    return CAPTCHA_TEXT_RE.test(body.replace(CAPTCHA_BADGE_RE, ""));
  } catch { return false; }
}

const FORM_ERROR_SEL = "[role=alert], .error, .alert, [class*=error], [class*=invalid], [aria-invalid=true] ~ *, [id*=error], .help-block, .form-text";
const FORM_ERROR_RE = /incorrect|invalid|invalide|erron|wrong|doesn.t match|ne correspond|try again|r[ée]essay|unrecognized|non reconnu|inconnu|verrouill|locked|too many|trop de tentatives|refus|denied|unable to (sign|log)|impossible de vous/i;
/** Toute URL d'un texte réduite à origine + chemin (jamais un jeton), sans dépendre de login.js. */
const scrubText = s => String(s).replace(/https?:\/\/[^\s"')<>]+/g, u => publicUrl(u));

/**
 * Texte d'erreur visible près du formulaire après soumission (mot de passe refusé, compte verrouillé…) :
 * éléments FORM_ERROR_SEL dans le <form> du champ, puis ses 6 ancêtres (puis le corps si `field` manque),
 * dont le texte correspond à FORM_ERROR_RE. Renvoie ≤ 120 caractères, sans URL, ou null. `mask` : valeurs
 * (identifiant, mot de passe) qui ne doivent JAMAIS apparaître — remplacées par « [masqué] ».
 */
export async function readFormError(page, site, field, mask = []) {
  if (!page || page.isClosed()) return null;
  try {
    const el = field ? (field.el || field) : null;
    const frame = field?.frame || page.mainFrame();
    if (field && !onSite(page, site, frame)) return null;
    // Appelé par Locator.evaluate (node, opts) ou par Frame.evaluate (opts seul) : même fonction.
    const fn = (node, opts) => {
      if (!opts) { opts = node; node = null; }
      const { sel, re } = opts;
      const RE = new RegExp(re, "i");
      const visible = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
      const roots = [];
      if (node) {
        const form = node.closest("form");
        if (form) roots.push(form);
        let a = node;
        for (let i = 0; i < 6 && a && a.parentElement; i++) { a = a.parentElement; roots.push(a); }
      } else roots.push(document.body);
      for (const root of roots) {
        let list;
        try { list = root.querySelectorAll(sel); } catch { continue; }
        for (const e of list) {
          if (!visible(e)) continue;
          const text = (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
          if (text && text.length <= 600 && RE.test(text)) return text;
        }
      }
      return null;
    };
    const opts = { sel: FORM_ERROR_SEL, re: FORM_ERROR_RE.source };
    let raw = null;
    let near = false;
    if (el) {
      // Le champ a pu disparaître avec sa page (navigation après l'étape 1) : on le résout SANS attendre —
      // Locator.evaluate attendrait son réattachement 30 s — et, s'il n'est plus là, on cherche dans le corps.
      const h = await el.elementHandle({ timeout: 500 }).catch(() => null);
      if (h) {
        near = true;
        raw = await h.evaluate(fn, opts).catch(() => null);
        await h.dispose().catch(() => {});
      }
    }
    if (!near) raw = await frame.evaluate(fn, opts).catch(() => null);
    if (!raw) return null;
    let text = scrubText(raw);
    const collapse = s => String(s || "").replace(/\s+/g, " ").trim();
    const bare = s => String(s || "").replace(/\s+/g, "").toLowerCase();
    for (const v of mask) {
      const val = collapse(v);
      if (!val) continue;
      // Le texte lu a ses blancs normalisés (une tabulation, deux espaces, un retour à la ligne → un espace) :
      // la valeur l'est aussi, et chaque blanc vaut « un ou plusieurs blancs ». Une seule passe, insensible à
      // la casse ; si la valeur apparaît encore (blancs compris ou non — très courte, contenue dans le masque
      // lui-même), tout le texte est masqué plutôt que de laisser passer quoi que ce soit.
      const pattern = val.split(" ").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
      text = text.replace(new RegExp(pattern, "gi"), "[masqué]");
      if (bare(text).includes(bare(val))) text = "[masqué]";
    }
    return text.slice(0, 120);
  } catch { return null; }
}

/** `session.aliveSel` (sélecteur visible seulement connecté) est-il à l'écran ? false sans sélecteur. */
export async function aliveSelVisible(page, site) {
  const sel = site?.session?.aliveSel;
  if (!sel || !page || page.isClosed()) return false;
  return !!(await locate(page, site, sel, []).catch(() => null));
}

/** Solidité d'un verdict « connecté » : high (successUrl vérifié ou aliveSel visible), medium (looksSignedIn), low sinon. */
async function signedInConfidence(page, site, { successVerified = false } = {}) {
  if (successVerified) return "high";
  if (await aliveSelVisible(page, site)) return "high";
  if (await looksSignedIn(page, site).catch(() => false)) return "medium";
  return "low";
}

/** Pose un code sur un résultat de fillLogin (voir src/outcomes.js). */
const coded = (code, result, extra) => withOutcome(result, code, extra);

/** Frame qui possède un Locator (frame principale par défaut). */
async function frameOf(loc, page) {
  try {
    const h = await loc.elementHandle({ timeout: 1000 });
    const f = h ? await h.ownerFrame() : null;
    await h?.dispose().catch(() => {});
    return f || page.mainFrame();
  } catch { return page.mainFrame(); }
}

// --- Sonde de session --------------------------------------------------------------------------------------
// Même regex que looksSignedIn : une adresse de connexion/déconnexion/erreur n'est jamais une cible de sonde.
const NOT_PROBE_PATH_RE = /log-?in|log-?out|sign-?in|sign-?up|auth|connexion|deconnexion|erreur|error|404|not-?found/i;
const deadUrlMatches = (site, url) => {
  const re = site?.session?.deadUrlRe;
  if (!re) return false;
  try { return new RegExp(re, "i").test(url); } catch { return String(url).includes(re); }
};

/**
 * Sonde la session d'un site SANS rien remplir ni lire de secret : dit si l'onglet du site est connecté
 * (alive), déconnecté (dead), indéterminé (unknown) ou au milieu d'un défi (challenge : mot de passe, code
 * ou captcha à l'écran — alors AUCUNE navigation, on ne casse pas un parcours en cours).
 * Cible de la sonde : site.session.probeUrl ; à défaut l'URL courante de l'onglet si elle est sur le site
 * et ne ressemble pas à une page de connexion/déconnexion ; sinon loginUrl. Sans onglet : openPage. Avec :
 * page.goto. Puis jusqu'à 8 s (pas de 500 ms) tant que rien de concluant n'apparaît (redirections).
 * Verdict dans cet ordre : deadUrlRe ⇒ dead ; aliveSel visible ⇒ alive ; formulaire ⇒ dead ;
 * looksSignedIn ⇒ alive ; sinon unknown.
 * Renvoie { state, page, url (publique), reason, aliveSel (true si c'est le sélecteur qui a tranché) }.
 */
export async function probeSession(browser, site, { onEvent = () => {} } = {}) {
  const session = site?.session || {};
  const loginUrl = site.loginUrl || `https://${site.domain}/`;
  let page = await claimSiteTab(browser, site, { onEvent });
  const finish = (state, reason, extra = {}) => {
    const url = publicUrl(page && !page.isClosed() ? page.url() : "");
    onEvent({ result: "sonde", detail: `${state} — ${reason}${url ? ` (${url})` : ""}` });
    return { state, page, url, reason, ...extra };
  };
  // 1. Défi en cours → aucune navigation.
  if (page) {
    if (await locate(page, site, site.selectors?.password, PASS_SELECTORS)) return finish("challenge", "champ mot de passe à l'écran", { challenge: "password" });
    const sf = await detectSecondFactor(page, site);
    if (sf) return finish("challenge", `code attendu (${sf.detail})`, { challenge: "code", secondFactor: sf });
    if (await detectCaptcha(page)) return finish("challenge", "captcha ou vérification humaine à l'écran", { challenge: "captcha" });
  }
  // 2. Cible.
  let target = session.probeUrl;
  if (!target && page) {
    const cur = page.url();
    let pathOk = false;
    try { const u = new URL(cur); pathOk = !NOT_PROBE_PATH_RE.test(u.pathname + u.hash); } catch {}
    if (siteMatchesUrl(site, cur) && pathOk && !deadUrlMatches(site, cur)) target = cur;
  }
  if (!target) target = loginUrl;
  if (!page) page = await openPage(browser, target);
  else await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  // 3. Laisser les redirections finir : jusqu'à 8 s tant que rien de concluant n'est là.
  const deadline = Date.now() + 8000;
  let verdict = null;
  const judge = async () => {
    if (page.isClosed()) return { state: "unknown", reason: "onglet fermé pendant la sonde" };
    const url = page.url();
    if (deadUrlMatches(site, url)) return { state: "dead", reason: "adresse de session morte (deadUrlRe)" };
    if (await aliveSelVisible(page, site)) return { state: "alive", reason: "sélecteur de session visible (aliveSel)", aliveSel: true };
    if (await hasLoginFields(page, site)) return { state: "dead", reason: "formulaire de connexion affiché" };
    if (await looksSignedIn(page, site)) return { state: "alive", reason: "page interne avec signe de session" };
    return null;
  };
  while (!(verdict = await judge()) && Date.now() < deadline) await page.waitForTimeout(500).catch(() => {});
  if (!verdict) verdict = { state: "unknown", reason: "ni formulaire ni signe de session après 8 s" };
  return finish(verdict.state, verdict.reason, { aliveSel: !!verdict.aliveSel });
}

/** Le bouton de soumission est cherché près du champ rempli (son <form>, puis ses conteneurs), pas n'importe où dans la page.
 *  Juste avant : la case « rester connecté » est cochée si elle existe (tickRememberMe). */
async function submit(page, site, lastField, steps = [], mask = []) {
  if (lastField) await tickRememberMe(page, site, { el: lastField, frame: await frameOf(lastField, page) }, steps, mask);
  if (site.selectors?.submit) {
    const hit = await locate(page, site, site.selectors.submit, []);
    if (hit && await hit.el.click({ timeout: 5000 }).then(() => true).catch(() => false)) return "bouton";
  }
  if (lastField) {
    const form = lastField.locator("xpath=ancestor::form[1]");
    // Un clic qui n'aboutit pas (bouton recouvert, page qui bouge) ne vaut pas soumission : Entrée.
    const cliquer = async btn => btn.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if ((await form.count().catch(() => 0)) > 0) {
      const btn = await firstVisible(page, SUBMIT_SELECTORS, form);
      if (btn && await cliquer(btn)) return "bouton";
    } else {
      for (let i = 1; i <= 6; i++) {
        const box = lastField.locator(`xpath=ancestor::*[${i}]`);
        if ((await box.count().catch(() => 0)) === 0) break;
        const btn = await firstVisible(page, SUBMIT_SELECTORS, box);
        if (btn && await cliquer(btn)) return "bouton";
      }
    }
    await lastField.press("Enter").catch(() => {});
    return "Entrée";
  }
  return "aucun";
}

/** Attend (jusqu'à `ms`) que le champ mot de passe disparaisse : la soumission a été prise en compte. */
async function waitPasswordGone(page, site, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (page.isClosed()) return true;
    if (!(await locate(page, site, site.selectors?.password, PASS_SELECTORS))) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

/** Champ mot de passe visible dans UNE frame donnée (pas de recherche globale) : sélecteur du site, ou générique. */
async function passInFrame(page, site, frame) {
  const sels = site.selectors?.password ? [site.selectors.password] : PASS_SELECTORS;
  const el = await firstVisible(page, sels, frame);
  return el ? { el, frame } : null;
}

/**
 * L'onglet est parti hors périmètre : la page où il se trouve montre-t-elle déjà un mot de passe, en
 * https (ou http sur un hôte local, bancs d'essai), sur sa frame principale ? Si oui, renvoie le domaine
 * enregistrable candidat (siteDomainFor) ; sinon null. Jamais restreint au site visé : c'est justement
 * parce que la page n'y correspond plus qu'on cherche à savoir si un nouveau domaine mérite d'être proposé.
 */
async function detectNeedsDomain(page) {
  if (page.isClosed()) return null;
  const url = page.url();
  let u;
  try { u = new URL(url); } catch { return null; }
  const local = ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
  const pwd = await firstVisible(page, PASS_SELECTORS); // frame principale seulement
  if (!pwd) return null;
  return siteDomainFor(url);
}

async function isSearchLike(el) {
  return el.evaluate(e => {
    const s = [e.type, e.name, e.id, e.placeholder, e.getAttribute("role"), e.getAttribute("aria-label"), e.autocomplete].join(" ").toLowerCase();
    // « emailCode » (Chorus Pro), « smsCode », « codeEmail » : un code ENVOYÉ par e-mail ou SMS, pas un champ
    // d'adresse. Sans cette exception, le mot « email » dans le nom le faisait écarter comme identifiant.
    if (e.type !== "email" && /code|otp|jeton|token|\bpin\b|verif/.test(s)) return false;
    return /search|recherch|\bq\b|username|email/.test(s) || e.type === "email";
  }).catch(() => false);
}

/**
 * Le site demande-t-il un code (2e facteur) ? Renvoie { kind, detail } ou null.
 *  - "champ"      : champ de code identifié (attente bloquante justifiée)
 *  - "texte-seul" : la page parle d'un code mais sans champ (choix de méthode, validation sur téléphone) → indice, pas d'attente
 */
export async function detectSecondFactor(page, site) {
  if (page.isClosed()) return null;
  if (await locate(page, site, site.selectors?.password, PASS_SELECTORS)) return null; // encore au mot de passe
  if (site.selectors?.code) {
    const hit = await locate(page, site, site.selectors.code, []);
    if (hit) return { kind: "champ", detail: "champ de code (sélecteur du site)" };
  }
  const strong = await locate(page, site, null, OTP_STRONG);
  if (strong && !(await isSearchLike(strong.el))) {
    const meta = await strong.el.evaluate(el => ({ type: el.type, ml: el.maxLength })).catch(() => ({}));
    return { kind: "champ", detail: `champ ${meta.type || "texte"}${meta.ml > 0 ? " (" + meta.ml + " car.)" : ""}` };
  }
  const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const m = bodyText.match(OTP_TEXT);
  if (!m) return null;
  const weak = await locate(page, site, null, OTP_WEAK);
  if (weak && !(await isSearchLike(weak.el))) return { kind: "champ", detail: `« ${m[0].trim()} »` };
  return { kind: "texte-seul", detail: `« ${m[0].trim()} »` };
}

/** L'élément du champ de code, s'il est là : même logique que detectSecondFactor, mais on veut l'élément. */
async function locateCode(page, site) {
  if (site.selectors?.code) return locate(page, site, site.selectors.code, []);
  const strong = await locate(page, site, null, OTP_STRONG);
  if (strong && !(await isSearchLike(strong.el))) return strong;
  const weak = await locate(page, site, null, OTP_WEAK);
  if (weak && !(await isSearchLike(weak.el))) return weak;
  return null;
}

/** Bandeau dans la page, là où l'utilisateur va taper le code. Silencieux si la page ne s'y prête pas. */
async function showBanner(page, text) {
  await page.evaluate(t => {
    let b = document.getElementById("sesame-banner");
    if (!b) {
      b = document.createElement("div");
      b.id = "sesame-banner";
      b.setAttribute("role", "status");
      b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:12px 18px;background:#1A1714;color:#F2EDE3;font:15px/1.4 -apple-system,Helvetica,Arial,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center";
      const dot = document.createElement("span");
      dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#D9A340;flex:none;animation:sesame-pulse 1.2s infinite";
      const st = document.createElement("style");
      st.textContent = "@keyframes sesame-pulse{0%,100%{opacity:1}50%{opacity:.25}}";
      b.appendChild(st); b.appendChild(dot);
      const span = document.createElement("span"); span.id = "sesame-banner-text"; b.appendChild(span);
      document.documentElement.appendChild(b);
    }
    document.getElementById("sesame-banner-text").textContent = t;
  }, text).catch(() => {});
}
async function hideBanner(page) {
  await page.evaluate(() => document.getElementById("sesame-banner")?.remove()).catch(() => {});
}

/**
 * Attend que l'utilisateur saisisse le code du 2e facteur et que le site l'accepte.
 * Fin « done » : plus aucun champ de code ni de mot de passe, deux contrôles de suite, onglet toujours sur le site.
 * Fin « échec » : onglet fermé ou parti ailleurs, retour au formulaire mot de passe (code refusé), ou délai.
 * Renvoie { done, elapsedSec, reason? }.
 */
/**
 * @param {object} [o]
 * @param {() => Promise<{code:string}|null>} [o.autoCode] cherche le code là où le site l'a envoyé (boîte
 *   mail de l'utilisateur, voir src/mailbox.js). Appelé toutes les 5 s. S'il en renvoie un, Sésame le TAPE
 *   lui-même dans le champ et soumet : le code ne quitte jamais ce processus. L'utilisateur peut toujours
 *   le taper à la main en même temps — le premier des deux gagne, la boucle s'arrête dès que le site accepte.
 */
export async function waitForSecondFactor(page, site, { timeoutSec = 180, message, onTick, autoCode } = {}) {
  const started = Date.now();
  let deadline = started + timeoutSec * 1000;
  const banner = remaining => message || t("banner_wait_code", { remaining });
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  let clear = 0;
  let autoFilled = false;
  let lastCodeLook = 0;
  await setWindowState(page, "normal");      // dépliée si elle était réduite
  await page.bringToFront().catch(() => {}); // ici, oui : l'utilisateur doit taper le code
  activateChrome();
  await showBanner(page, banner(timeoutSec));
  while (Date.now() < deadline) {
    if (page.isClosed()) return { done: false, elapsedSec: elapsed(), reason: "onglet fermé pendant l'attente du code" };
    if (!siteMatchesUrl(site, page.url())) return { done: false, elapsedSec: elapsed(), reason: `onglet parti vers ${publicUrl(page.url())}` };
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const pwd = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
    if (pwd) { await hideBanner(page); return { done: false, elapsedSec: elapsed(), reason: "retour au formulaire mot de passe (code refusé ?)" }; }
    const still = await detectSecondFactor(page, site);
    if (!still || still.kind === "texte-seul") { clear++; } else { clear = 0; }
    if (clear >= 2) {
      await hideBanner(page);
      return { done: true, elapsedSec: elapsed(), auto: autoFilled };
    }
    if (onTick) { try { await onTick(remaining); } catch {} }
    // Toutes les 5 s au moins : le code est peut-être arrivé dans la boîte mail. Sésame le saisit lui-même.
    // Intervalle mesuré, jamais un modulo : une interrogation qui dure plus d'une seconde sauterait sinon
    // des tours entiers (constaté sur Chorus Pro : code trouvé au bout de 107 s au lieu de quelques-unes).
    if (autoCode && !autoFilled && Date.now() - lastCodeLook >= 5000) {
      lastCodeLook = Date.now();
      let hit = null;
      try { hit = await autoCode(); } catch {}
      if (hit && hit.code) {
        const field = await locateCode(page, site);
        if (field && onSite(page, site, field.frame)) {
          await typeCode(page, field.el, hit.code);
          hit.code = "";                                   // oublié tout de suite
          autoFilled = true;
          await submit(page, site, field.el).catch(() => {});
          // Le site vient de recevoir le code : lui laisser le temps de l'accepter, même si le délai
          // demandé touchait à sa fin (sinon on déclarerait un échec alors que tout est joué).
          deadline = Math.max(deadline, Date.now() + 45000);
          await showBanner(page, t("banner_code_auto"));
        }
      }
    }
    await showBanner(page, autoFilled ? t("banner_code_auto") : banner(remaining));
    await page.waitForTimeout(1000);
  }
  await hideBanner(page);
  return { done: false, elapsedSec: timeoutSec, reason: "délai dépassé" };
}

/**
 * Remplit identifiant + mot de passe dans la page, gère les connexions en deux étapes
 * (identifiant → Continuer → mot de passe) et, si le site demande un code (2e facteur),
 * prévient l'utilisateur et attend qu'il le saisisse avant de rendre la main. Ne renvoie JAMAIS les valeurs.
 * Avant chaque frappe, l'onglet et la frame sont revérifiés : toujours sur le site, sinon abandon.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.submitForm=true]
 * @param {boolean} [opts.waitSecondFactor=true]  attendre le code si le site en demande un
 * @param {number}  [opts.secondFactorTimeoutSec=180]
 * @param {(info:{kind:string,detail:string}) => void} [opts.onSecondFactor]  appelé quand un code est demandé (notification, journal)
 * @param {(info:{detail:string}) => void} [opts.onStep]  appelé à chaque étape de la connexion par fournisseur (journal)
 */
export async function fillLogin(page, site, secret, { submitForm = true, waitSecondFactor = true, secondFactorTimeoutSec = 180, onSecondFactor, autoCode, onStep } = {}) {
  const steps = [];
  // Un bandeau de cookies qui recouvre la page fait rater les clics (champ, bouton) : on le refuse d'abord.
  const bandeau = await ecarterBandeauCookies(page).catch(() => null);
  if (bandeau) steps.push(`bandeau de cookies refusé (« ${bandeau} »)`);
  const where = frame => (frame && frame !== page.mainFrame() ? ` (iframe ${publicUrl(frame.url())})` : "");
  const gone = hostname => coded("fail.tab_left", { ok: false, steps, url: publicUrl(page.isClosed() ? "" : page.url()), reason: `onglet parti vers ${hostname || "une autre page"} : remplissage abandonné` });
  const mask = [secret?.password, secret?.username].filter(v => typeof v === "string" && v.length > 0);
  // Codes d'une attente de code interrompue (waitForSecondFactor) : retour au mot de passe = code refusé, sinon onglet parti.
  const interruptedCode = reason => (/retour au formulaire mot de passe/.test(reason || "") ? "fail.code_rejected" : "fail.tab_left");
  const pendingActor = autoCode ? "sesame" : "user";
  /**
   * Abandon parce que l'onglet est parti hors périmètre : apprentissage assisté. Si la nouvelle page
   * (frame principale, https) montre déjà un champ mot de passe, on ne se contente pas d'abandonner :
   * on renvoie le domaine enregistrable candidat pour que src/login.js propose de l'autoriser (jamais
   * d'ajout automatique). Sinon, abandon classique.
   */
  const bail = async () => {
    if (!page.isClosed()) {
      const nd = await detectNeedsDomain(page);
      if (nd && nd !== site.domain) {
        return coded("fail.domain_approval", { ok: false, steps, url: publicUrl(page.url()), needsDomain: nd, reason: `onglet parti vers ${nd} pour le mot de passe : domaine à autoriser ?` });
      }
    }
    return gone(page.isClosed() ? "(onglet fermé)" : publicUrl(page.url()));
  };

  // Pas de passage au premier plan : la connexion se fait en arrière-plan, Chrome ne vient devant que pour un code.
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});

  // Site déclaré « connexion par fournisseur d'identité » : on clique son bouton et on laisse la session
  // déjà ouverte dans ce navigateur terminer. Sésame ne tape RIEN chez le fournisseur : si celui-ci demande
  // un compte, un mot de passe ou un code, on s'arrête et on le dit.
  if (isProviderSite(site)) {
    let found = await findProviderButton(page, site, site.authProvider);
    if (!found) {
      // Pas de bouton fournisseur : page d'accueil publique où le site a renvoyé la page de connexion
      // (Indeed : employers.indeed.com → fr.indeed.com/recrutement/cs). Une page publique propose toujours
      // « Se connecter » ; une session ouverte, non. On clique cette entrée, une fois, avant de conclure
      // « déjà connecté » — la redirection hors page de connexion seule n'est PAS une preuve de session.
      const entry = await findClickableByText(page, site, PROVIDER_ENTRY_RE, LOGIN_ENTRY_EXCLUDE_RE);
      if (entry && onSite(page, site, entry.frame)) {
        await entry.el.click({ timeout: 5000 }).catch(() => {});
        const msg = "entrée « se connecter » cliquée pour atteindre le bouton du fournisseur";
        steps.push(msg); onStep?.({ detail: msg });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1200);
        found = await findProviderButton(page, site, site.authProvider);
      }
    }
    if (!found) {
      if (!(await findClickableByText(page, site, PROVIDER_ENTRY_RE, LOGIN_ENTRY_EXCLUDE_RE)) && await looksSignedIn(page, site)) {
        steps.push("session déjà ouverte : rien à faire");
        return coded("ok.already_signed_in", { ok: true, steps, url: publicUrl(page.url()), title: await page.title().catch(() => ""), alreadySignedIn: true }, { confidence: await aliveSelVisible(page, site) ? "high" : "medium" });
      }
      return coded("fail.no_form", { ok: false, steps, url: publicUrl(page.url()),
        reason: `« ${site.key} » se connecte par ${PROVIDERS[site.authProvider]?.label || site.authProvider}, mais le bouton n'est pas sur cette page. Ouvre-la toi-même, ou corrige le sélecteur (providerSel).` });
    }
    const label = PROVIDERS[found.provider]?.label || found.provider;
    const step = msg => { steps.push(msg); onStep?.({ detail: msg }); };
    // Le fournisseur s'ouvre parfois dans une fenêtre à part : on garde les pages apparues pendant le clic.
    const opened = [];
    const onPage = p => opened.push(p);
    page.context().on("page", onPage);
    try {
      await found.hit.el.click({ timeout: 5000 }).catch(() => {});
      step(`« se connecter avec ${label} » cliqué`);
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const getCur = () => {
        const w = opened.filter(p => !p.isClosed() && isProviderUrl(site.authProvider, p.url())).pop();
        return w || page;
      };
      // Choix du compte chez le fournisseur : un clic sur la tuile du compte déclaré, jamais de saisie.
      const choice = await chooseProviderAccount({ site, label, getCur, step });
      if (choice.stop) {
        const where = publicUrl(getCur().url());
        return coded("fail.provider_intervention", { ok: false, steps, url: where, needsProvider: found.provider, reason: choice.stop.reason });
      }
      // Revenu sur le site (la fenêtre du fournisseur, s'il y en avait une, s'est refermée) : on laisse la redirection finir.
      const until = Date.now() + 10000;
      while (Date.now() < until && !page.isClosed() && isProviderUrl(site.authProvider, page.url())) await page.waitForTimeout(400);
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    } finally {
      page.context().off("page", onPage);
    }
    // Revenu sur le site et connecté : la session du fournisseur a suffi.
    if (siteMatchesUrl(site, page.url()) && !(await hasLoginFields(page, site))) {
      step(`connexion par ${label} acceptée`);
      return coded("ok.via_provider", { ok: true, steps, url: publicUrl(page.url()), title: await page.title().catch(() => ""), viaProvider: found.provider }, { confidence: await signedInConfidence(page, site) });
    }
    // Toujours chez le fournisseur (ou revenu sans être connecté) : il demande quelque chose. On n'y touche pas.
    const here = publicUrl(page.url());
    return coded("fail.provider_intervention", { ok: false, steps, url: here, needsProvider: found.provider,
      reason: `${label} demande une intervention (choix du compte, mot de passe, code ou validation) sur ${here}. Sésame ne saisit jamais rien chez un fournisseur d'identité : ouvre cette page et termine la connexion, elle restera ouverte ensuite.` });
  }

  let user = secret.username ? await locateUser(page, site) : null;
  let pass = await locate(page, site, site.selectors?.password, PASS_SELECTORS);

  // Ni champ ni écran de compte : la page redirige peut-être encore (Orange : login.orange.fr/ →
  // keep-connected prend 2-4 s après le premier rendu). On repasse toutes les 500 ms, jusqu'à 8 s, tant
  // que rien de reconnaissable n'est là — sans jamais attendre pour rien quand le formulaire est déjà visible.
  const settleDeadline = Date.now() + 8000;
  while (!user && !pass && Date.now() < settleDeadline) {
    if (await detectAccountScreen(page, site)) break;
    await page.waitForTimeout(500);
    user = secret.username ? await locateUser(page, site) : null;
    pass = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
  }
  if (!user && !pass) {
    // Écran « session déjà ouverte / choix de compte » (ex. Orange keep-connected) : ni identifiant ni mot
    // de passe visibles, mais un bouton « continuer avec ce compte » ou un lien « changer de compte ».
    const handled = await tryAccountScreen(page, site, secret, steps, bail);
    if (handled) {
      if (handled.finished) return handled.result;
      user = secret.username ? await locateUser(page, site) : null;
      pass = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
      if (!user && !pass) {
        // Après « changer de compte », le formulaire peut apparaître avec un léger délai.
        await page.waitForTimeout(1000);
        user = secret.username ? await locateUser(page, site) : null;
        pass = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
      }
    }
  }
  if (!user && !pass && !(await detectAccountScreen(page, site))) {
    // Formulaire peut-être replié derrière une entrée « Se connecter » : un seul clic, puis on regarde.
    if (await openLoginForm(page, site, steps)) {
      user = secret.username ? await locateUser(page, site) : null;
      pass = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
    }
  }
  if (!user && !pass) {
    // Ni formulaire ni écran de compte, mais la page propose de se déconnecter : la session est déjà
    // ouverte (le site a redirigé la page de connexion vers son tableau de bord). C'est un succès.
    if (await looksSignedIn(page, site)) {
      steps.push("session déjà ouverte : le site est connecté, aucun formulaire à remplir");
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      return coded("ok.already_signed_in", { ok: true, steps, url: publicUrl(page.url()), title: await page.title().catch(() => ""), alreadySignedIn: true }, { confidence: await aliveSelVisible(page, site) ? "high" : "medium" });
    }
    // Captcha ou vérification humaine à la place du formulaire : le dire, plutôt qu'« aucun champ ».
    if (await detectCaptcha(page)) {
      return coded("fail.captcha", { ok: false, steps, url: publicUrl(page.url()), reason: "Un captcha ou une vérification humaine s'affiche à la place du formulaire : Sésame n'y touche pas. L'utilisateur doit passer cette étape lui-même dans le Chrome Sésame." });
    }
    // La page de connexion mène hors du périmètre du site (fournisseur d'identité sur un autre hôte, comme
    // idmsa.apple.com pour Apple) : les champs y sont ignorés à dessein. Le dire, et proposer d'autoriser ce
    // domaine — l'utilisateur tranche une fois, Sésame s'en souvient (apprentissage assisté).
    const host = hostnameOf(page.url());
    if (host && !siteMatchesUrl(site, page.url())) {
      const cand = validateExtraDomain(site.domain, host);
      if (cand.domain) {
        return coded("fail.domain_approval", { ok: false, steps, url: publicUrl(page.url()), needsDomain: cand.domain,
          reason: `la page de connexion de « ${site.key} » mène à ${cand.domain}, hors du périmètre du site : domaine à autoriser ?` });
      }
    }
    return coded("fail.no_form", { ok: false, steps, url: publicUrl(page.url()), reason: "Aucun champ identifiant/mot de passe visible sur cet onglet. Ouvre la page de connexion d'abord (sesame_open_login)." });
  }

  if (user) {
    if (!onSite(page, site, user.frame)) return await bail();
    await typeInto(user.el, secret.username);
    steps.push(`identifiant rempli${where(user.frame)}`);
    if (!pass) {
      // Un champ mot de passe visible dans la MÊME frame doit être rempli AVANT tout clic (sinon un rendu
      // tardif après hydratation ferait cliquer « Suivant » à tort, sautant le mot de passe — cas Yealink).
      // S'il n'apparaît pas tout de suite, on attend 1 s et on relocalise avant de conclure à une connexion
      // en deux étapes.
      pass = await passInFrame(page, site, user.frame);
      if (!pass) {
        await page.waitForTimeout(1000);
        if (!onSite(page, site, user.frame)) return await bail();
        pass = await passInFrame(page, site, user.frame);
      }
    }
  }

  if (!pass && user) {
    // Connexion en deux étapes confirmée : on valide l'identifiant et on attend le mot de passe.
    const how = await submit(page, site, user.el, steps, [secret?.password, secret?.username]);
    steps.push(`étape 1 validée (${how})`);
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 20 && !pass; i++) {
      await page.waitForTimeout(500);
      if (page.isClosed() || !siteMatchesUrl(site, page.url())) return await bail();
      pass = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
    }
    if (!pass) {
      // Pas de mot de passe, mais un code à usage unique : certains sites se connectent SANS mot de passe
      // (Chorus Pro : code envoyé par e-mail juste après l'identifiant). Ce n'est pas un échec.
      // Le champ de code arrive parfois après le texte qui l'annonce (Chorus Pro) : on laisse jusqu'à 6 s.
      let sf = await detectSecondFactor(page, site);
      for (let i = 0; i < 12 && (!sf || sf.kind === "texte-seul"); i++) {
        await page.waitForTimeout(500);
        if (page.isClosed() || !siteMatchesUrl(site, page.url())) break;
        const again = await detectSecondFactor(page, site);
        if (again) sf = again;
        if (sf && sf.kind !== "texte-seul") break;
      }
      if (sf && sf.kind !== "texte-seul") {
        steps.push(`code demandé par le site, sans mot de passe (${sf.detail})`);
        if (onSecondFactor) { try { await onSecondFactor(sf); } catch {} }
        if (!waitSecondFactor) {
          // Code attendu, attente désactivée par l'appelant : en attente (ok: false), pas une réussite.
          return coded("pending.second_factor", { ok: false, steps, url: publicUrl(page.url()), title: await page.title().catch(() => ""),
            secondFactor: { pending: true, ...sf },
            reason: "Ce site n'a pas de mot de passe : il envoie un code. L'utilisateur doit le saisir, puis appelle sesame_wait_code.",
            hint: "Ce site n'a pas de mot de passe : il envoie un code. L'utilisateur doit le saisir, puis appelle sesame_wait_code." }, { actor: pendingActor });
        }
        const w = await waitForSecondFactor(page, site, { timeoutSec: secondFactorTimeoutSec, autoCode });
        if (!w.done) {
          const pending = w.reason === "délai dépassé";
          return coded(pending ? "pending.second_factor" : interruptedCode(w.reason), { ok: false, steps, url: publicUrl(page.isClosed() ? "" : page.url()),
            reason: pending
              ? `Ce site n'a pas de mot de passe : il attend un code, non saisi dans le délai (${secondFactorTimeoutSec} s). Appelle sesame_wait_code quand l'utilisateur est prêt.`
              : `Attente du code interrompue : ${w.reason}.`,
            secondFactor: { pending, ...sf } }, pending ? { actor: pendingActor } : {});
        }
        steps.push(w.auto ? `code récupéré dans votre boîte mail et saisi par Sésame, connexion poursuivie (${w.elapsedSec} s)` : `code saisi par l'utilisateur, connexion poursuivie (${w.elapsedSec} s)`);
        await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
        return coded("ok.signed_in", { ok: true, steps, url: publicUrl(page.isClosed() ? "" : page.url()),
          title: page.isClosed() ? "" : await page.title().catch(() => ""), secondFactor: { pending: false, ...sf } },
          { confidence: page.isClosed() ? "low" : await signedInConfidence(page, site) });
      }
      // Ni mot de passe ni champ de code après l'identifiant : captcha ? session ouverte dès l'identifiant
      // (Expedia, identité vivante) ? identifiant refusé ? sinon « pas d'étape mot de passe ».
      const here = publicUrl(page.isClosed() ? "" : page.url());
      if (await detectCaptcha(page)) {
        return coded("fail.captcha", { ok: false, steps, url: here, reason: "Un captcha ou une vérification humaine s'est interposé après l'identifiant : Sésame n'y touche pas. L'utilisateur doit passer cette étape lui-même dans le Chrome Sésame." });
      }
      let successVerified = false;
      if (site.successUrl && !page.isClosed()) {
        const landed = page.url();
        try { successVerified = new RegExp(site.successUrl, "i").test(landed); } catch { successVerified = landed.includes(site.successUrl); }
      }
      if (successVerified || await aliveSelVisible(page, site) || await looksSignedIn(page, site)) {
        steps.push("session ouverte dès l'identifiant, sans mot de passe");
        return coded("ok.signed_in_after_step1", { ok: true, steps, url: here, title: page.isClosed() ? "" : await page.title().catch(() => "") },
          { confidence: await signedInConfidence(page, site, { successVerified }) });
      }
      const errorText = await readFormError(page, site, user, mask);
      if (errorText) {
        return coded("fail.password_rejected", { ok: false, steps, url: here, errorText, reason: `Identifiant refusé par le site après l'étape 1 : « ${errorText} ».` });
      }
      if (sf) {
        steps.push(`la page évoque un code (${sf.detail}) sans champ de saisie`);
        return coded("pending.second_factor_no_field", { ok: false, steps, url: here, secondFactor: { pending: true, ...sf },
          reason: `La page évoque un 2e facteur sans champ de saisie (${sf.detail}) : l'utilisateur doit d'abord choisir la méthode ou valider sur son téléphone. Appelle sesame_wait_code ensuite.` });
      }
      return coded("fail.no_password_step", { ok: false, steps, url: here, reason: "Le champ mot de passe n'est pas apparu après l'identifiant (ni code, ni session ouverte : sélecteur à préciser, ou le site a changé)." });
    }
  }

  // Page liée à un compte DÉJÀ choisi (un mot de passe, aucun champ identifiant) : vérifier que c'est bien
  // le nôtre AVANT de taper. Sans ce garde-fou, Sésame a tapé le mot de passe partenaire de Booking sur la
  // page du compte VOYAGEUR resté connecté dans ce navigateur — un vrai mot de passe envoyé au mauvais compte.
  if (!user && secret.username) {
    const shown = findAccountCandidates(await accountDisplayText(page, site));
    if (shown.length && !shown.some(c => accountMatches(c, secret.username))) {
      steps.push("page liée à un autre compte que celui enregistré : rien saisi, tentative de changement de compte");
      const handled = await tryAccountScreen(page, site, secret, steps, bail);
      if (handled?.finished) return handled.result;
      const userAgain = secret.username ? await locateUser(page, site) : null;
      const passAgain = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
      if (!userAgain) {
        return coded("fail.wrong_account", { ok: false, steps, url: publicUrl(page.url()),
          reason: `Cette page demande le mot de passe d'un AUTRE compte que celui enregistré pour « ${site.key} » : une session d'un autre compte est ouverte dans ce navigateur. Rien n'a été saisi. Déconnecte ce compte, ou ouvre directement la page de connexion du bon espace.` });
      }
      if (!onSite(page, site, userAgain.frame)) return await bail();
      await typeInto(userAgain.el, secret.username);
      steps.push(`identifiant rempli après changement de compte${where(userAgain.frame)}`);
      user = userAgain;
      if (passAgain) pass = passAgain;
      else {
        const found = await (async () => { for (let i = 0; i < 16; i++) { await page.waitForTimeout(500); const h = await locate(page, site, site.selectors?.password, PASS_SELECTORS); if (h) return h; } return null; })();
        if (!found) return coded("fail.no_password_step", { ok: false, steps, url: publicUrl(page.url()), reason: "Après changement de compte, le champ mot de passe n'est pas réapparu." });
        pass = found;
      }
    }
  }

  if (!onSite(page, site, pass.frame)) return await bail();
  await typeInto(pass.el, secret.password);
  // Certaines pages (Booking) remontent le champ après coup et le vident : on relit la valeur
  // avant de soumettre et on retape, au plus trois fois, en retrouvant le champ s'il a changé.
  for (let essai = 0; essai < 3; essai++) {
    await page.waitForTimeout(700);
    const len = await pass.el.evaluate(e => (e.value || "").length).catch(() => -1);
    if (len === secret.password.length) break;
    const again = await locate(page, site, site.selectors?.password, PASS_SELECTORS).catch(() => null);
    if (again && again.el) pass = again;
    await typeInto(pass.el, secret.password).catch(() => {});
  }
  steps.push(`mot de passe rempli${where(pass.frame)}`);

  let secondFactor = null;
  if (submitForm) {
    const how = await submit(page, site, pass.el, steps, [secret?.password, secret?.username]);
    steps.push(`formulaire soumis (${how})`);
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    // Laisser le site basculer avant de juger : mot de passe refusé ou 2e facteur ?
    const passwordGone = await waitPasswordGone(page, site, 8000);
    if (!passwordGone) {
      // Le formulaire est toujours là : la connexion n'a PAS abouti. On vide le champ, puis on répond un
      // échec — longtemps Sésame renvoyait « ok » avec un simple indice, et l'IA annonçait une réussite.
      // Classement : fournisseur d'identité (SSO) → captcha → message d'erreur du site → formulaire inchangé.
      const still = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
      if (still) await still.el.fill("").catch(() => {});
      const body = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      const prov = await findProviderButton(page, site);
      if (SSO_TEXT_RE.test(body) || prov) {
        const label = prov ? (PROVIDERS[prov.provider]?.label || prov.provider) : "un fournisseur d'identité";
        return coded("fail.provider_needed", { ok: false, steps, url: publicUrl(page.url()), needsProvider: prov?.provider || "sso",
          reason: `« ${site.key} » n'a pas de mot de passe : ce compte se connecte par ${label} (authentification unique). Le mot de passe a été refusé. Déclare le site avec authProvider pour que Sésame clique ce bouton au lieu d'essayer un mot de passe.` });
      }
      if (await detectCaptcha(page)) {
        return coded("fail.captcha", { ok: false, steps, url: publicUrl(page.url()),
          reason: "Un captcha ou une vérification humaine s'est interposé : le formulaire est encore affiché après soumission (le champ a été vidé). L'utilisateur doit passer cette étape lui-même dans le Chrome Sésame." });
      }
      const errorText = await readFormError(page, site, still || pass, mask);
      if (errorText) {
        return coded("fail.password_rejected", { ok: false, steps, url: publicUrl(page.url()), errorText,
          reason: `Le site a refusé la connexion : « ${errorText} » (le champ mot de passe a été vidé). Vérifie l'identifiant et le mot de passe enregistrés.` });
      }
      return coded("fail.form_unchanged", { ok: false, steps, url: publicUrl(page.url()),
        reason: "Le formulaire est encore affiché après soumission, sans message d'erreur ni captcha visibles (le champ mot de passe a été vidé). Le site n'a peut-être pas réagi : réessaie plus tard." });
    } else if (!page.isClosed()) {
      await page.waitForTimeout(800);
      const sf = await detectSecondFactor(page, site);
      if (sf && sf.kind === "texte-seul") {
        steps.push(`la page évoque un code (${sf.detail}) sans champ de saisie`);
        return coded("pending.second_factor_no_field", { ok: false, steps, url: publicUrl(page.url()), title: await page.title().catch(() => ""),
          secondFactor: { pending: true, ...sf },
          reason: "La page évoque un 2e facteur sans champ visible (validation sur téléphone ? choix de méthode ?) : vérifie l'onglet, puis appelle sesame_wait_code une fois le champ de code affiché.",
          hint: "La page évoque un 2e facteur sans champ visible (validation sur téléphone ? choix de méthode ?) : vérifie l'onglet, puis appelle sesame_wait_code une fois le champ de code affiché." });
      } else if (sf) {
        steps.push(`code demandé par le site (${sf.detail})`);
        if (onSecondFactor) { try { await onSecondFactor(sf); } catch {} }
        if (waitSecondFactor) {
          const w = await waitForSecondFactor(page, site, { timeoutSec: secondFactorTimeoutSec, autoCode });
          if (!w.done) {
            const pending = w.reason === "délai dépassé";
            return coded(pending ? "pending.second_factor" : interruptedCode(w.reason), {
              ok: false, steps, url: publicUrl(page.isClosed() ? "" : page.url()),
              reason: pending
                ? `L'utilisateur n'a pas saisi le code dans le délai (${secondFactorTimeoutSec} s). Le formulaire est toujours ouvert : appelle sesame_wait_code quand l'utilisateur est prêt.`
                : `Attente du code interrompue : ${w.reason}.`,
              secondFactor: { pending, ...sf },
            }, pending ? { actor: pendingActor } : {});
          }
          steps.push(w.auto ? `code récupéré dans votre boîte mail et saisi par Sésame, connexion poursuivie (${w.elapsedSec} s)` : `code saisi par l'utilisateur, connexion poursuivie (${w.elapsedSec} s)`);
          secondFactor = { pending: false, ...sf };
          await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(800);
        } else {
          // Code attendu, attente désactivée par l'appelant : en attente (ok: false), pas une réussite.
          return coded("pending.second_factor", { ok: false, steps, url: publicUrl(page.url()), title: await page.title().catch(() => ""),
            secondFactor: { pending: true, ...sf },
            reason: "Le site attend un code (2e facteur) : l'utilisateur doit le saisir dans le Chrome Sésame, puis appelle sesame_wait_code.",
            hint: "Le site attend un code (2e facteur) : l'utilisateur doit le saisir dans le Chrome Sésame, puis appelle sesame_wait_code." }, { actor: pendingActor });
        }
      }
    }
  }

  // Interstitiel anti-robot APRÈS la soumission (le mot de passe a disparu, mais un défi a pris sa place).
  // Jugé AVANT successUrl : le défi de Booking s'affiche sur account.booking.com, pas sur l'extranet attendu —
  // conclure « arrivé ailleurs, mauvais compte » serait faux et cacherait le chemin humain.
  if (submitForm && !page.isClosed() && await detectCaptcha(page)) {
    return coded("fail.captcha", { ok: false, steps, url: publicUrl(page.url()),
      reason: "Après la soumission, un captcha ou une vérification humaine s'affiche : Sésame n'y touche pas. L'utilisateur doit passer cette étape lui-même dans le Chrome Sésame." });
  }

  // Certaines connexions aboutissent « quelque part » sur le même domaine sans être la bonne : l'extranet
  // partenaire de Booking et son site voyageur partagent booking.com. `successUrl` dit où l'on doit arriver.
  let successVerified = false;
  if (site.successUrl && !page.isClosed()) {
    const landed = page.url();
    try { successVerified = new RegExp(site.successUrl, "i").test(landed); } catch { successVerified = landed.includes(site.successUrl); }
    if (!successVerified) {
      return coded("fail.landed_elsewhere", { ok: false, steps, url: publicUrl(landed),
        reason: `La connexion a abouti, mais sur ${publicUrl(landed)} au lieu de l'espace attendu pour « ${site.key} » (${site.successUrl}). C'est probablement le mauvais compte ou le mauvais espace.` });
    }
    steps.push("arrivé dans l'espace attendu");
  }

  return coded("ok.signed_in", {
    ok: true,
    steps,
    url: publicUrl(page.isClosed() ? "" : page.url()),
    title: page.isClosed() ? "" : await page.title().catch(() => ""),
    secondFactor: secondFactor || undefined,
  }, { confidence: !submitForm ? "low" : page.isClosed() ? "low" : await signedInConfidence(page, site, { successVerified }) });
}
