// Connexion à Chrome (protocole DevTools) et remplissage des champs.
// Chrome doit tourner avec --remote-debugging-port (voir `sesame chrome`).
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { CDP_URL, CHROME_PROFILE, siteMatchesUrl, hostnameOf, siteDomainFor, validateExtraDomain } from "./config.js";
import { t } from "./i18n.js";

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
const LOGIN_ENTRY_RE = /se connecter|connexion|espace priv[ée]|identifiez-vous|mon compte|my account|log ?in|sign ?in/i;
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

async function launchChromeOnce({ waitMs = 15000 } = {}) {
  const bin = process.env.SESAME_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!fs.existsSync(bin)) throw new Error("Google Chrome n'est pas dans /Applications : installe-le, ou lance le Chrome Sésame à la main.");
  const port = CDP_URL.split(":").pop();
  // SESAME_CHROME_HEADLESS=1 : Chrome sans fenêtre. Réservé aux bancs d'essai — ils ne doivent pas faire
  // surgir de fenêtres sur l'écran de l'utilisateur pendant qu'ils tournent.
  const headless = process.env.SESAME_CHROME_HEADLESS === "1" ? ["--headless=new"] : [];
  const child = spawn(bin, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${CHROME_PROFILE}`,
    "--no-first-run", "--no-default-browser-check", "--password-store=basic", ...headless, "about:blank",
  ], { detached: true, stdio: "ignore" });
  child.unref();
  launchedPid = child.pid;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await cdpReachable()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
let launchedPid = null;
/** Arrête le Chrome lancé par ce processus (bancs d'essai). */
export function stopLaunchedChrome() {
  if (launchedPid) { try { process.kill(launchedPid, "SIGTERM"); } catch {} launchedPid = null; }
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
function sesameChromePids() {
  try {
    return execFileSync("/usr/bin/pgrep", ["-f", "--", `--user-data-dir=${CHROME_PROFILE}`], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean).map(Number);
  } catch { return []; }
}

/** Arrête (SIGTERM puis, s'il le faut, SIGKILL) tous les processus Chrome Sésame et attend qu'ils disparaissent. */
async function killSesameChrome(waitMs = 8000) {
  const pids = sesameChromePids();
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && sesameChromePids().length) await new Promise(r => setTimeout(r, 300));
  for (const pid of sesameChromePids()) { try { process.kill(pid, "SIGKILL"); } catch {} }
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
    const up = await launchChrome();
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
    const up = await launchChrome();
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
      if (await el.isVisible().catch(() => false) && await el.isEditable().catch(() => true)) return el;
    }
  }
  return null;
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
      result: {
        ok: true, steps, url: publicUrl(page.url()), title: await page.title().catch(() => ""),
        alreadySignedIn: true,
      },
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
  if (n >= 4 && n === chiffres.length) {
    // Une case par chiffre : on clique chaque case et on tape son chiffre, sans compter sur le passage
    // automatique d'une case à l'autre (il perd des touches quand le composant est lent).
    for (let i = 0; i < n; i++) {
      const c = await cases.evaluateHandle((l, i) => l[i], i);
      await c.asElement().click({ timeout: 5000 }).catch(() => {});
      await page.keyboard.type(chiffres[i], { delay: 60 });
      await page.waitForTimeout(120);
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
  await el.click({ timeout: 5000 }).catch(() => {});
  await el.fill("", { timeout: 5000 }).catch(() => {});
  await el.fill(value, { timeout: 5000 });
}

/** Le bouton de soumission est cherché près du champ rempli (son <form>, puis ses conteneurs), pas n'importe où dans la page. */
async function submit(page, site, lastField) {
  if (site.selectors?.submit) {
    const hit = await locate(page, site, site.selectors.submit, []);
    if (hit) { await hit.el.click({ timeout: 5000 }).catch(() => {}); return "bouton"; }
  }
  if (lastField) {
    const form = lastField.locator("xpath=ancestor::form[1]");
    if ((await form.count().catch(() => 0)) > 0) {
      const btn = await firstVisible(page, SUBMIT_SELECTORS, form);
      if (btn) { await btn.click({ timeout: 5000 }).catch(() => {}); return "bouton"; }
    } else {
      for (let i = 1; i <= 6; i++) {
        const box = lastField.locator(`xpath=ancestor::*[${i}]`);
        if ((await box.count().catch(() => 0)) === 0) break;
        const btn = await firstVisible(page, SUBMIT_SELECTORS, box);
        if (btn) { await btn.click({ timeout: 5000 }).catch(() => {}); return "bouton"; }
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
 */
export async function fillLogin(page, site, secret, { submitForm = true, waitSecondFactor = true, secondFactorTimeoutSec = 180, onSecondFactor, autoCode } = {}) {
  const steps = [];
  const where = frame => (frame && frame !== page.mainFrame() ? ` (iframe ${publicUrl(frame.url())})` : "");
  const gone = hostname => ({ ok: false, steps, url: publicUrl(page.isClosed() ? "" : page.url()), reason: `onglet parti vers ${hostname || "une autre page"} : remplissage abandonné` });
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
        return { ok: false, steps, url: publicUrl(page.url()), needsDomain: nd, reason: `onglet parti vers ${nd} pour le mot de passe : domaine à autoriser ?` };
      }
    }
    return gone(page.isClosed() ? "(onglet fermé)" : publicUrl(page.url()));
  };

  // Pas de passage au premier plan : la connexion se fait en arrière-plan, Chrome ne vient devant que pour un code.
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});

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
      return { ok: true, steps, url: publicUrl(page.url()), title: await page.title().catch(() => ""), alreadySignedIn: true };
    }
    // La page de connexion mène hors du périmètre du site (fournisseur d'identité sur un autre hôte, comme
    // idmsa.apple.com pour Apple) : les champs y sont ignorés à dessein. Le dire, et proposer d'autoriser ce
    // domaine — l'utilisateur tranche une fois, Sésame s'en souvient (apprentissage assisté).
    const host = hostnameOf(page.url());
    if (host && !siteMatchesUrl(site, page.url())) {
      const cand = validateExtraDomain(site.domain, host);
      if (cand.domain) {
        return { ok: false, steps, url: publicUrl(page.url()), needsDomain: cand.domain,
          reason: `la page de connexion de « ${site.key} » mène à ${cand.domain}, hors du périmètre du site : domaine à autoriser ?` };
      }
    }
    return { ok: false, steps, reason: "Aucun champ identifiant/mot de passe visible sur cet onglet. Ouvre la page de connexion d'abord (sesame_open_login)." };
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
    const how = await submit(page, site, user.el);
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
          return { ok: true, steps, url: publicUrl(page.url()), title: await page.title().catch(() => ""),
            secondFactor: { pending: true, ...sf },
            hint: "Ce site n'a pas de mot de passe : il envoie un code. L'utilisateur doit le saisir, puis appelle sesame_wait_code." };
        }
        const w = await waitForSecondFactor(page, site, { timeoutSec: secondFactorTimeoutSec, autoCode });
        if (!w.done) {
          const pending = w.reason === "délai dépassé";
          return { ok: false, steps, url: publicUrl(page.isClosed() ? "" : page.url()),
            reason: pending
              ? `Ce site n'a pas de mot de passe : il attend un code, non saisi dans le délai (${secondFactorTimeoutSec} s). Appelle sesame_wait_code quand l'utilisateur est prêt.`
              : `Attente du code interrompue : ${w.reason}.`,
            secondFactor: { pending, ...sf } };
        }
        steps.push(w.auto ? `code récupéré dans votre boîte mail et saisi par Sésame, connexion poursuivie (${w.elapsedSec} s)` : `code saisi par l'utilisateur, connexion poursuivie (${w.elapsedSec} s)`);
        await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
        return { ok: true, steps, url: publicUrl(page.isClosed() ? "" : page.url()),
          title: page.isClosed() ? "" : await page.title().catch(() => ""), secondFactor: { pending: false, ...sf } };
      }
      if (sf) steps.push(`la page évoque un code (${sf.detail}) sans champ de saisie`);
      return { ok: false, steps, url: publicUrl(page.url()), reason: "Le champ mot de passe n'est pas apparu après l'identifiant (captcha, code SMS, ou sélecteur à préciser)." };
    }
  }

  if (!onSite(page, site, pass.frame)) return await bail();
  await typeInto(pass.el, secret.password);
  steps.push(`mot de passe rempli${where(pass.frame)}`);

  let secondFactor = null;
  let hint;
  if (submitForm) {
    const how = await submit(page, site, pass.el);
    steps.push(`formulaire soumis (${how})`);
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    // Laisser le site basculer avant de juger : mot de passe refusé ou 2e facteur ?
    const passwordGone = await waitPasswordGone(page, site, 8000);
    if (!passwordGone) {
      // Le formulaire est toujours là : on ne laisse pas le mot de passe dans la page.
      const still = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
      if (still) await still.el.fill("").catch(() => {});
      hint = "Un champ mot de passe est encore visible : identifiants refusés ou captcha probable (champ vidé).";
    } else if (!page.isClosed()) {
      await page.waitForTimeout(800);
      const sf = await detectSecondFactor(page, site);
      if (sf && sf.kind === "texte-seul") {
        steps.push(`la page évoque un code (${sf.detail}) sans champ de saisie`);
        hint = "La page évoque un 2e facteur sans champ visible (validation sur téléphone ? choix de méthode ?) : vérifie l'onglet, puis appelle sesame_wait_code une fois le champ de code affiché.";
      } else if (sf) {
        steps.push(`code demandé par le site (${sf.detail})`);
        if (onSecondFactor) { try { await onSecondFactor(sf); } catch {} }
        if (waitSecondFactor) {
          const w = await waitForSecondFactor(page, site, { timeoutSec: secondFactorTimeoutSec, autoCode });
          if (!w.done) {
            const pending = w.reason === "délai dépassé";
            return {
              ok: false, steps, url: publicUrl(page.isClosed() ? "" : page.url()),
              reason: pending
                ? `L'utilisateur n'a pas saisi le code dans le délai (${secondFactorTimeoutSec} s). Le formulaire est toujours ouvert : appelle sesame_wait_code quand l'utilisateur est prêt.`
                : `Attente du code interrompue : ${w.reason}.`,
              secondFactor: { pending, ...sf },
            };
          }
          steps.push(w.auto ? `code récupéré dans votre boîte mail et saisi par Sésame, connexion poursuivie (${w.elapsedSec} s)` : `code saisi par l'utilisateur, connexion poursuivie (${w.elapsedSec} s)`);
          secondFactor = { pending: false, ...sf };
          await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(800);
        } else {
          secondFactor = { pending: true, ...sf };
          hint = "Le site attend un code (2e facteur) : l'utilisateur doit le saisir dans le Chrome Sésame, puis appelle sesame_wait_code.";
        }
      }
    }
  }

  return {
    ok: true,
    steps,
    url: publicUrl(page.isClosed() ? "" : page.url()),
    title: page.isClosed() ? "" : await page.title().catch(() => ""),
    secondFactor: secondFactor || undefined,
    hint,
  };
}
