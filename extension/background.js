// Sésame — service worker de l'extension (Manifest V3).
//
// Rôle : tenir la liaison avec le pont natif (bin/sesame-bridge.js, lancé par Chrome par la messagerie native),
// recevoir ses ordres (« prepare », « fill », « waitCode », « ping »), orchestrer le remplissage dans l'onglet du
// site et répondre. Les heuristiques de page vivent dans content.js (injecté à la demande) ; ici : choix de
// l'onglet, frames autorisées, navigations, délais, et sécurité (URL de l'onglet revérifiée avant chaque frappe,
// https exigé, secret transmis à une seule frame du site, jamais réinjecté après une navigation).
//
// Règles :
//  - ne jamais écrire un secret ni un message de remplissage dans la console (log() ne reçoit que des types,
//    des ids et des motifs) ;
//  - effacer identifiant et mot de passe dès qu'ils ont été transmis à la frame choisie ;
//  - ne renvoyer au pont que des étapes, une URL publique (sans paramètres ni fragment), un titre et des motifs ;
//  - protocole en deux temps : le secret n'arrive (« fill ») qu'après un « prepare » réussi, c'est-à-dire une
//    fois qu'un formulaire de connexion a été vu sur un onglet https du bon domaine ; un « fill » sans jobId
//    valide (inconnu, expiré après 60 s, déjà consommé) est refusé sans rien toucher.
//
// Protocole (voir README) :
//   pont → extension : { id, type: "prepare", site }
//                      { id, type: "fill", jobId, username, password, submit, waitCode, codeTimeoutSec }
//                      { id, type: "waitCode", site, timeoutSec }
//                      { id, type: "ping" }
//   extension → pont : { id, type: "ready", ok, jobId, url, steps, reason }
//                      { id, type: "result", ok, steps, url, title, secondFactor, hint, reason }
//                      { id, type: "pong", version }

"use strict";

// Nom du pont natif : « app.sesamekey.bridge » (manifeste écrit par `sesame install extension`). Les bancs
// d'essai le remplacent par un nom de test via chrome.storage.local (clé bridgeName) — honoré SEULEMENT pour
// une extension non empaquetée (chargée depuis un dossier, sans update_url) : une extension du Web Store
// ignore la clé. Rien d'autre n'est jamais rangé dans le stockage — aucun identifiant, aucun secret.
const DEFAULT_HOST = "app.sesamekey.bridge";
const MANIFEST = chrome.runtime.getManifest();
const DEV = !("update_url" in MANIFEST);
let HOST = DEFAULT_HOST;
const VERSION = MANIFEST.version;
const JOB_TTL_MS = 60000;            // validité d'une préparation (prepare → fill)
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1"];
async function bridgeName() {
  if (!DEV) return DEFAULT_HOST;
  try {
    const r = await chrome.storage.local.get("bridgeName");
    const n = r && typeof r.bridgeName === "string" ? r.bridgeName.trim() : "";
    return /^[a-z0-9._]{1,120}$/.test(n) ? n : DEFAULT_HOST;
  } catch { return DEFAULT_HOST; }
}
const log = (...a) => console.log("[Sésame]", ...a); // uniquement des chaînes sûres

// ----------------------------------------------------------------------------------------------
// Liaison avec le pont natif
// ----------------------------------------------------------------------------------------------
let port = null;
let backoffMs = 1000;
let reconnectTimer = null;
let keepalive = null;
const state = { connected: false, since: null, lastError: null, lastMessageAt: null, busy: 0 };

function persistState() {
  try { chrome.storage.session.set({ bridge: { ...state } }); } catch {}
}

/** Ouvre le port natif ; une reconnexion est programmée à chaque coupure (délai croissant, 1 s → 60 s). */
let connecting = false;
let renameWhileConnecting = false; // nom changé pendant une connexion en cours : on la refera au nouveau nom
async function connectBridge() {
  if (port || connecting) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connecting = true;
  let p;
  try {
    HOST = await bridgeName();
    if (port) { connecting = false; return; } // connecté entre-temps
    p = chrome.runtime.connectNative(HOST);
  } catch (e) {
    connecting = false;
    state.lastError = safeError(e);
    state.connected = false;
    persistState();
    scheduleReconnect();
    return;
  }
  connecting = false;
  port = p;
  p.onMessage.addListener(onBridgeMessage);
  p.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
    if (port && port !== p) return; // port déjà remplacé (reconnectNow) : rien à faire
    port = null;
    state.connected = false; state.since = null; state.lastError = err ? safeError(err) : null;
    persistState();
    stopKeepalive();
    log("pont natif déconnecté :", state.lastError || "(fin normale)");
    scheduleReconnect();
  });
  state.connected = true; state.since = Date.now(); state.lastError = null;
  persistState();
  startKeepalive();
  log("port natif ouvert vers", HOST);
  if (renameWhileConnecting) { renameWhileConnecting = false; reconnectNow(); }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectBridge(); }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 60000);
}
/** Ferme le port courant (sans passer par onDisconnect) et se reconnecte tout de suite, au nom en vigueur. */
function reconnectNow() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  backoffMs = 1000;
  if (connecting) { renameWhileConnecting = true; return; }
  if (port) {
    const p = port; port = null;
    try { p.disconnect(); } catch {}
    state.connected = false; state.since = null;
    stopKeepalive();
    persistState();
  }
  connectBridge();
}
// Le nom du pont a changé (banc d'essai, extension non empaquetée seulement) : on lâche l'ancien pont et on rejoint le nouveau.
chrome.storage.onChanged.addListener((changes, area) => {
  if (!DEV || area !== "local" || !changes || !("bridgeName" in changes)) return;
  log("nom du pont modifié, reconnexion");
  reconnectNow();
});

/**
 * Chrome arrête un service worker inactif au bout de ~30 s et tue alors le pont natif. Tant que le port est
 * ouvert, un appel d'API périodique remet le compteur à zéro : le pont reste joignable par le serveur MCP.
 */
function startKeepalive() {
  if (keepalive) return;
  keepalive = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch {} }, 25000);
}
function stopKeepalive() {
  if (keepalive) { clearInterval(keepalive); keepalive = null; }
}

function send(obj) {
  if (!port) { log("réponse perdue : port natif fermé", String(obj && obj.type)); return; }
  try { port.postMessage(obj); } catch (e) { log("envoi au pont impossible :", safeError(e)); }
}

function onBridgeMessage(msg) {
  backoffMs = 1000;
  state.lastMessageAt = Date.now();
  persistState();
  if (!msg || typeof msg !== "object") return;
  const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
  const type = String(msg.type || "");
  if (type === "ping") { send({ id, type: "pong", version: VERSION }); return; }
  if (type === "prepare") {
    const site = msg.site;
    log("ordre reçu :", type, String(id), String(site && site.key));
    enqueue(() => runPrepare(site))
      .then(r => send({ id, type: "ready", ...finishReady(r) }))
      .catch(e => send({ id, type: "ready", ...finishReady({ ok: false, reason: safeError(e) }) }));
    return;
  }
  if (type === "fill") {
    // Le secret sort du message tout de suite : seul `order` le porte, jusqu'à la frappe.
    const order = {
      jobId: typeof msg.jobId === "string" ? msg.jobId : "",
      submit: msg.submit !== false, waitCode: msg.waitCode !== false,
      codeTimeoutSec: clamp(Number(msg.codeTimeoutSec) || 180, 10, 900),
      secret: { username: typeof msg.username === "string" ? msg.username : "", password: typeof msg.password === "string" ? msg.password : "" },
    };
    msg.username = undefined; msg.password = undefined;
    log("ordre reçu :", type, String(id));
    enqueue(() => runFill(order))
      .then(r => send({ id, type: "result", ...finish(r) }))
      .catch(e => send({ id, type: "result", ...finish({ ok: false, reason: safeError(e) }) }))
      .finally(() => { order.secret.username = ""; order.secret.password = ""; });
    return;
  }
  if (type === "waitCode") {
    const order = { site: msg.site, timeoutSec: clamp(Number(msg.timeoutSec) || 180, 10, 900) };
    log("ordre reçu :", type, String(id), String(order.site && order.site.key));
    enqueue(() => runWaitCode(order))
      .then(r => send({ id, type: "result", ...finish(r) }))
      .catch(e => send({ id, type: "result", ...finish({ ok: false, reason: safeError(e) }) }));
    return;
  }
  log("message du pont ignoré :", type.slice(0, 40));
}

// Une opération à la fois : deux remplissages simultanés se disputeraient les onglets.
let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  state.busy++;
  run.then(() => { state.busy--; }, () => { state.busy--; });
  return run;
}

/** Forme exacte de la réponse « result » : jamais d'autre champ. */
function finish(r) {
  return {
    ok: !!(r && r.ok),
    steps: r && Array.isArray(r.steps) ? r.steps : [],
    url: (r && r.url) || "",
    title: (r && r.title) || "",
    secondFactor: (r && r.secondFactor) || null,
    hint: (r && r.hint) || null,
    reason: (r && r.reason) || null,
  };
}
/** Forme exacte de la réponse « ready ». */
function finishReady(r) {
  return {
    ok: !!(r && r.ok),
    jobId: (r && r.ok && r.jobId) || null,
    url: (r && r.url) || "",
    steps: r && Array.isArray(r.steps) ? r.steps : [],
    reason: (r && r.reason) || null,
  };
}
/** Message d'erreur relayable : première ligne, URL réduites à origine + chemin (jamais un code OAuth ou un jeton de lien), 300 caractères. */
function safeError(e) {
  return String(e && e.message ? e.message : e || "erreur inconnue").split("\n")[0]
    .replace(/https?:\/\/[^\s"')<>]+/g, u => publicUrl(u)).slice(0, 300);
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ----------------------------------------------------------------------------------------------
// Site, URL
// ----------------------------------------------------------------------------------------------
function hostnameOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; } }
function publicUrl(u) { try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u || "").split(/[?#]/)[0]; } }
/** Une page qui reçoit un identifiant est en https ; http toléré pour un hôte local seulement (bancs d'essai) — même règle que le serveur. */
function secureUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.includes(u.hostname));
  } catch { return false; }
}
function siteMatchesUrl(site, url) {
  const h = hostnameOf(url);
  if (!h) return false;
  const domains = [site.domain, ...(site.extraDomains || [])].filter(Boolean);
  return domains.some(d => h === d || h.endsWith("." + d));
}
/** Description du site telle que reçue du pont, nettoyée : rien d'autre ne circule vers les pages. null si loginUrl n'est pas https. */
function normalizeSite(s) {
  if (!s || typeof s !== "object" || typeof s.domain !== "string" || !s.domain) return null;
  const domain = s.domain.toLowerCase().replace(/^www\./, "");
  const loginUrl = typeof s.loginUrl === "string" && s.loginUrl ? s.loginUrl : `https://${domain}/`;
  if (!secureUrl(loginUrl)) return null;
  const sel = s.selectors && typeof s.selectors === "object" ? s.selectors : {};
  const site = {
    key: String(s.key || domain), domain, loginUrl,
    selectors: Object.fromEntries(Object.entries(sel).filter(([, v]) => typeof v === "string" && v)),
  };
  if (Array.isArray(s.extraDomains)) site.extraDomains = s.extraDomains.filter(d => typeof d === "string" && d);
  return site;
}
function loginUrlOf(site) { return site.loginUrl; }

// ----------------------------------------------------------------------------------------------
// Onglets
// ----------------------------------------------------------------------------------------------
async function getTab(tabId) { try { return await chrome.tabs.get(tabId); } catch { return null; } }
/** L'onglet est-il toujours sur le site, en https ? Vérifié juste avant chaque frappe. */
async function onSite(tabId, site) {
  const t = await getTab(tabId);
  return !!t && secureUrl(t.url || "") && siteMatchesUrl(site, t.url);
}
async function waitTabLoaded(tabId, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await getTab(tabId);
    if (!t) return false;
    if (t.status === "complete") return true;
    await sleep(200);
  }
  return false;
}
/** Ouvre la page dans un nouvel onglet, en arrière-plan : Chrome ne vient devant que pour un code à saisir. */
async function openPage(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  await waitTabLoaded(tab.id, 30000);
  return tab.id;
}
/** Amène l'onglet devant l'utilisateur (code à taper) : onglet actif, fenêtre dépliée et au premier plan. */
async function bringToFront(tabId) {
  try {
    const t = await chrome.tabs.update(tabId, { active: true });
    const w = await chrome.windows.get(t.windowId);
    if (w.state === "minimized") await chrome.windows.update(t.windowId, { state: "normal" });
    await chrome.windows.update(t.windowId, { focused: true, drawAttention: true });
  } catch {}
}

// ----------------------------------------------------------------------------------------------
// Frames : injection du script de contenu et dialogue frame par frame
// ----------------------------------------------------------------------------------------------
/** Injecte content.js dans toutes les frames de l'onglet (idempotent) ; renvoie les frameIds atteints. */
async function inject(tabId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"], injectImmediately: true });
      return res.filter(r => r && r.frameId != null).map(r => r.frameId);
    } catch {
      // Page en cours de navigation, ou frame récalcitrante : on retente, puis la frame principale seule.
      await sleep(300);
    }
  }
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"], injectImmediately: true });
    return res.map(r => r.frameId);
  } catch { return []; }
}
/**
 * Envoie une opération à UNE frame. Sur échec (document remplacé par une navigation) et si `reinject` est
 * permis — jamais pour un message qui porte un secret —, revérifie que l'onglet est toujours sur le site,
 * réinjecte et retente une fois. Le message est vidé de tout secret dès la réponse.
 */
async function ask(tabId, frameId, msg, { reinject = true } = {}) {
  const payload = { __sesame: true, ...msg };
  try {
    try {
      return await chrome.tabs.sendMessage(tabId, payload, { frameId });
    } catch {
      if (!reinject || "username" in payload || "password" in payload) return null;
      if (payload.site && !(await onSite(tabId, payload.site))) return null;
      await inject(tabId);
      try { return await chrome.tabs.sendMessage(tabId, payload, { frameId }); } catch { return null; }
    }
  } finally {
    payload.username = undefined; payload.password = undefined;
  }
}
/** Sonde toutes les frames de l'onglet ; ne garde que celles autorisées pour le site, frame principale d'abord. */
async function scan(tabId, site, op = "probe") {
  const tab = await getTab(tabId);
  if (!tab || !secureUrl(tab.url || "")) return [];
  const frameIds = await inject(tabId);
  const out = [];
  for (const frameId of frameIds) {
    const r = await ask(tabId, frameId, { op, site }, { reinject: false });
    if (r && r.allowed) out.push({ frameId, ...r });
  }
  out.sort((a, b) => (b.isTop ? 1 : 0) - (a.isTop ? 1 : 0) || a.frameId - b.frameId);
  return out;
}

/** Champ identifiant plausible : sélecteur du site, champ fort, ou champ faible sur la page de connexion / près d'un mot de passe. */
function pickUser(site, frames, pageUrl) {
  if (site.selectors.username) { const f = frames.find(x => x.userCustom); return f ? { ...f, mode: "custom" } : null; }
  const strong = frames.find(x => x.userStrong);
  if (strong) return { ...strong, mode: "strong" };
  const onLoginPage = !!site.loginUrl && hostnameOf(pageUrl) === hostnameOf(site.loginUrl);
  const nearPassword = frames.some(x => x.pass);
  if (onLoginPage || nearPassword) { const weak = frames.find(x => x.userWeak); if (weak) return { ...weak, mode: "weak" }; }
  return null;
}
function pickPass(frames) { return frames.find(x => x.pass) || null; }

/** L'onglet montre-t-il un formulaire de connexion (identifiant ou mot de passe) ? */
async function hasLoginFields(tabId, site) {
  const tab = await getTab(tabId);
  if (!tab) return false;
  const frames = await scan(tabId, site);
  return !!(pickPass(frames) || pickUser(site, frames, tab.url));
}
/** Ramène un onglet du site sur sa page de connexion (jusqu'à trois passages : certains liens déconnectent d'abord). */
async function gotoLogin(tabId, url, site) {
  for (let i = 0; i < 3; i++) {
    try { await chrome.tabs.update(tabId, { url }); } catch { return false; }
    await waitTabLoaded(tabId, 30000);
    await sleep(1200);
    if (await hasLoginFields(tabId, site)) return true;
  }
  return false;
}
/** Onglet https du site (le plus récent d'abord) : de préférence avec un champ mot de passe, puis un identifiant plausible. */
async function findTab(site) {
  const all = await chrome.tabs.query({});
  const tabs = all.filter(t => t.id != null && secureUrl(t.url || "") && siteMatchesUrl(site, t.url));
  if (tabs.length === 0) return null;
  tabs.sort((a, b) => ((b.lastAccessed || 0) - (a.lastAccessed || 0)) || (b.id - a.id));
  const scans = [];
  for (const t of tabs.slice(0, 8)) scans.push({ tab: t, frames: await scan(t.id, site).catch(() => []) });
  for (const s of scans) if (pickPass(s.frames)) return s.tab;
  for (const s of scans) if (pickUser(site, s.frames, s.tab.url)) return s.tab;
  return tabs[0];
}

// ----------------------------------------------------------------------------------------------
// 2e facteur
// ----------------------------------------------------------------------------------------------
/** Combine les sondages sfProbe des frames autorisées (même logique que detectSecondFactor côté serveur). */
function composeSecondFactor(site, frames) {
  if (frames.length === 0) return null;
  if (frames.some(f => f.pass)) return null; // encore au mot de passe
  if (site.selectors.code && frames.some(f => f.customCode)) return { kind: "champ", detail: "champ de code (sélecteur du site)" };
  const s = frames.find(f => f.strong);
  if (s && !s.strong.searchLike) return { kind: "champ", detail: `champ ${s.strong.type}${s.strong.ml > 0 ? " (" + s.strong.ml + " car.)" : ""}` };
  const top = frames.find(f => f.isTop);
  const m = top && top.text;
  if (!m) return null;
  if (frames.some(f => f.weak)) return { kind: "champ", detail: `« ${m} »` };
  return { kind: "texte-seul", detail: `« ${m} »` };
}
async function detectSecondFactor(tabId, site) {
  return composeSecondFactor(site, await scan(tabId, site, "sfProbe"));
}
async function waitPasswordGone(tabId, site, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await getTab(tabId))) return true;
    if (!pickPass(await scan(tabId, site))) return true;
    await sleep(400);
  }
  return false;
}

// Signaux d'attente du code : bandeau dans la page (shadow root fermé, hôte au nom aléatoire), badge doré « 2FA »
// sur l'icône de l'extension, notification système — les deux derniers sont hors de portée de la page.
const NOTIFICATION_ID = "sesame-code";
const showBanner = (tabId, site, text) => ask(tabId, 0, { op: "banner", site, text });
const hideBanner = (tabId, site) => ask(tabId, 0, { op: "hideBanner", site }, { reinject: false });
async function startWaitSignals(tabId, site, timeoutSec, text) {
  try { await chrome.action.setBadgeBackgroundColor({ color: "#D9A340" }); await chrome.action.setBadgeTextColor({ color: "#1A1714" }); } catch {}
  try { await chrome.action.setBadgeText({ text: "2FA" }); } catch {}
  try {
    await chrome.notifications.create(NOTIFICATION_ID, {
      type: "basic", iconUrl: "icons/128.png", title: "Sésame attend votre code",
      message: `${site.domain} demande un code de vérification : tapez-le dans l'onglet du site. Sésame attend jusqu'à ${timeoutSec} s.`,
      priority: 1,
    });
  } catch {}
  await showBanner(tabId, site, text);
}
async function stopWaitSignals(tabId, site) {
  try { await chrome.action.setBadgeText({ text: "" }); } catch {}
  try { await chrome.notifications.clear(NOTIFICATION_ID); } catch {}
  await hideBanner(tabId, site);
}

/**
 * Attend que l'utilisateur saisisse le code et que le site l'accepte (le code n'est jamais lu).
 * Fin « done » : plus aucun champ de code ni de mot de passe, deux contrôles de suite, onglet toujours sur le site.
 * Fin « échec » : onglet fermé ou parti ailleurs, retour au mot de passe (code refusé), ou délai.
 * Les signaux d'attente sont retirés dans tous les cas (finally), y compris sur exception.
 */
async function waitForSecondFactor(tabId, site, { timeoutSec = 180 } = {}) {
  const started = Date.now();
  const deadline = started + timeoutSec * 1000;
  const banner = `Sésame attend que vous saisissiez le code reçu par e-mail, SMS ou application. La connexion reprendra toute seule dès que le site l'aura accepté (encore ${timeoutSec} s).`;
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  let clear = 0;
  await bringToFront(tabId); // ici, oui : l'utilisateur doit taper le code
  try {
    await startWaitSignals(tabId, site, timeoutSec, banner);
    while (Date.now() < deadline) {
      const tab = await getTab(tabId);
      if (!tab) return { done: false, elapsedSec: elapsed(), reason: "onglet fermé pendant l'attente du code" };
      if (!siteMatchesUrl(site, tab.url)) return { done: false, elapsedSec: elapsed(), reason: `onglet parti vers ${publicUrl(tab.url)}` };
      const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      const frames = await scan(tabId, site, "sfProbe");
      if (frames.some(f => f.pass)) return { done: false, elapsedSec: elapsed(), reason: "retour au formulaire mot de passe (code refusé ?)" };
      const still = composeSecondFactor(site, frames);
      if (!still || still.kind === "texte-seul") clear++; else clear = 0;
      if (clear >= 2) return { done: true, elapsedSec: elapsed() };
      await showBanner(tabId, site, banner.replace(/encore \d+ s/, `encore ${remaining} s`));
      await sleep(1000);
    }
    return { done: false, elapsedSec: timeoutSec, reason: "délai dépassé" };
  } finally {
    await stopWaitSignals(tabId, site);
  }
}

// ----------------------------------------------------------------------------------------------
// Remplissage (même déroulé que fillLogin côté serveur)
// ----------------------------------------------------------------------------------------------
async function fillLogin(tabId, site, secret, { submitForm, waitSecondFactor, secondFactorTimeoutSec, steps, deadline, ctl }) {
  const where = f => (f && !f.isTop ? ` (iframe ${f.url})` : "");
  const tabUrl = async () => { const t = await getTab(tabId); return t ? publicUrl(t.url) : ""; };
  const bail = async () => {
    const t = await getTab(tabId);
    return { ok: false, steps, url: t ? publicUrl(t.url) : "", reason: `onglet parti vers ${t ? publicUrl(t.url) : "(onglet fermé)"} : remplissage abandonné` };
  };
  const expired = async () => ({ ok: false, steps, url: await tabUrl(), reason: "délai de l'extension dépassé avant la frappe : remplissage abandonné" });

  // Pas de passage au premier plan : la connexion se fait en arrière-plan, Chrome ne vient devant que pour un code.
  await waitTabLoaded(tabId, 10000);
  let tab = await getTab(tabId);
  if (!tab) return bail();
  let frames = await scan(tabId, site);
  let user = secret.username ? pickUser(site, frames, tab.url) : null;
  let pass = pickPass(frames);

  if (!user && !pass) {
    // Parfois le formulaire arrive après un clic "Se connecter" : on attend un peu.
    await sleep(1500);
    tab = await getTab(tabId);
    if (!tab) return bail();
    frames = await scan(tabId, site);
    user = secret.username ? pickUser(site, frames, tab.url) : null;
    pass = pickPass(frames);
  }
  if (!user && !pass) {
    return { ok: false, steps, url: await tabUrl(), reason: "Aucun champ identifiant/mot de passe visible sur cet onglet. Ouvre la page de connexion d'abord (sesame_open_login)." };
  }

  let how = null;
  if (user) {
    if (ctl.aborted) return expired();
    if (!(await onSite(tabId, site))) return bail();
    // Jamais de réinjection pour un message qui porte un secret : si la frame a disparu, on s'arrête.
    const r = await ask(tabId, user.frameId, { op: "fillUser", site, username: secret.username, mode: user.mode, submit: !pass }, { reinject: false });
    if (!r || !r.ok) return { ok: false, steps, url: await tabUrl(), reason: r && r.error ? `identifiant : ${r.error}` : "le champ identifiant a disparu avant la frappe" };
    steps.push(`identifiant rempli${where(user)}`);
    how = r.how;
  }

  if (!pass && user) {
    // Connexion en deux étapes : l'identifiant a été validé, on attend le mot de passe.
    steps.push(`étape 1 validée (${how})`);
    await sleep(300);
    await waitTabLoaded(tabId, 15000);
    for (let i = 0; i < 20 && !pass; i++) {
      await sleep(500);
      if (ctl.aborted) return expired();
      if (!(await onSite(tabId, site))) return bail();
      frames = await scan(tabId, site);
      pass = pickPass(frames);
    }
    if (!pass) return { ok: false, steps, url: await tabUrl(), reason: "Le champ mot de passe n'est pas apparu après l'identifiant (captcha, code SMS, ou sélecteur à préciser)." };
  }

  if (ctl.aborted) return expired();
  if (!(await onSite(tabId, site))) return bail();
  const rp = await ask(tabId, pass.frameId, { op: "fillPassword", site, password: secret.password, submit: submitForm }, { reinject: false });
  if (!rp || !rp.ok) return { ok: false, steps, url: await tabUrl(), reason: rp && rp.error ? `mot de passe : ${rp.error}` : "le champ mot de passe a disparu avant la frappe" };
  steps.push(`mot de passe rempli${where(pass)}`);

  let secondFactor = null;
  let hint;
  if (submitForm) {
    steps.push(`formulaire soumis (${rp.how})`);
    await sleep(300);
    await waitTabLoaded(tabId, 20000);
    // Laisser le site basculer avant de juger : mot de passe refusé ou 2e facteur ?
    const passwordGone = await waitPasswordGone(tabId, site, 8000);
    if (!passwordGone) {
      // Le formulaire est toujours là : on ne laisse pas le mot de passe dans la page.
      const still = pickPass(await scan(tabId, site));
      if (still) await ask(tabId, still.frameId, { op: "clearPassword", site }, { reinject: false });
      hint = "Un champ mot de passe est encore visible : identifiants refusés ou captcha probable (champ vidé).";
    } else if (await getTab(tabId)) {
      await sleep(800);
      const sf = await detectSecondFactor(tabId, site);
      if (sf && sf.kind === "texte-seul") {
        steps.push(`la page évoque un code (${sf.detail}) sans champ de saisie`);
        hint = "La page évoque un 2e facteur sans champ visible (validation sur téléphone ? choix de méthode ?) : vérifie l'onglet, puis appelle sesame_wait_code une fois le champ de code affiché.";
      } else if (sf) {
        steps.push(`code demandé par le site (${sf.detail})`);
        if (waitSecondFactor) {
          // Le pont attend codeTimeoutSec + une marge : on ne dépasse pas le budget global de l'ordre.
          const budget = Math.max(10, Math.min(secondFactorTimeoutSec, Math.floor((deadline - Date.now()) / 1000)));
          const w = await waitForSecondFactor(tabId, site, { timeoutSec: budget });
          if (!w.done) {
            const pending = w.reason === "délai dépassé";
            return {
              ok: false, steps, url: await tabUrl(),
              reason: pending
                ? `L'utilisateur n'a pas saisi le code dans le délai (${secondFactorTimeoutSec} s). Le formulaire est toujours ouvert : appelle sesame_wait_code quand l'utilisateur est prêt.`
                : `Attente du code interrompue : ${w.reason}.`,
              secondFactor: { pending, ...sf },
            };
          }
          steps.push(`code saisi par l'utilisateur, connexion poursuivie (${w.elapsedSec} s)`);
          secondFactor = { pending: false, ...sf };
          await waitTabLoaded(tabId, 10000);
          await sleep(800);
        } else {
          secondFactor = { pending: true, ...sf };
          hint = "Le site attend un code (2e facteur) : l'utilisateur doit le saisir dans Chrome, puis appelle sesame_wait_code.";
        }
      }
    }
  }

  tab = await getTab(tabId);
  return { ok: true, steps, url: tab ? publicUrl(tab.url) : "", title: tab ? tab.title || "" : "", secondFactor, hint };
}

// ----------------------------------------------------------------------------------------------
// Protocole en deux temps : prepare (onglet + formulaire trouvés, jobId) puis fill (secret vers ce job)
// ----------------------------------------------------------------------------------------------
let job = null; // { id, site, tabId, steps, expires, timer, running } — une seule préparation à la fois
function dropJob() {
  if (job && job.timer) clearTimeout(job.timer);
  job = null;
}

/** Ordre « prepare » : onglet du site (ou page de connexion ouverte), formulaire vérifié, jobId valable 60 s. Aucun secret ici. */
async function runPrepare(rawSite) {
  const site = normalizeSite(rawSite);
  if (!site) return { ok: false, reason: "description du site invalide (domaine manquant ou loginUrl non https)" };
  if (job && job.running) return { ok: false, reason: "un remplissage est déjà en cours dans cette extension" };
  dropJob();
  const steps = [];
  let tabId;
  const existing = await findTab(site);
  if (!existing) {
    tabId = await openPage(loginUrlOf(site));
    steps.push("page de connexion ouverte dans un nouvel onglet");
  } else if (!(await hasLoginFields(existing.id, site))) {
    // Onglet du site sans formulaire (déjà connecté, tableau de bord, déconnexion) : on ouvre la page de
    // connexion dans un autre onglet, sans toucher à celui de l'utilisateur.
    tabId = await openPage(loginUrlOf(site));
    if (!(await hasLoginFields(tabId, site))) await gotoLogin(tabId, loginUrlOf(site), site);
    steps.push("page de connexion ouverte dans un nouvel onglet (l'onglet existant n'avait pas de formulaire)");
  } else {
    tabId = existing.id;
  }
  await waitTabLoaded(tabId, 10000);
  let found = await hasLoginFields(tabId, site);
  if (!found) { await sleep(1500); found = await hasLoginFields(tabId, site); } // le formulaire arrive parfois après un clic
  const t = await getTab(tabId);
  if (!t) return { ok: false, steps, reason: "onglet fermé pendant la préparation" };
  const url = publicUrl(t.url);
  if (!(await onSite(tabId, site))) return { ok: false, steps, url, reason: `onglet parti vers ${url} : préparation abandonnée` };
  if (!found) return { ok: false, steps, url, reason: "Aucun champ identifiant/mot de passe visible sur cet onglet. Ouvre la page de connexion d'abord (sesame_open_login)." };
  const id = crypto.randomUUID();
  job = { id, site, tabId, steps, expires: Date.now() + JOB_TTL_MS, running: false, timer: null };
  job.timer = setTimeout(() => { if (job && job.id === id && !job.running) { job = null; log("préparation expirée sans fill"); } }, JOB_TTL_MS);
  return { ok: true, jobId: id, url, steps };
}

/** Ordre « fill » : le secret ne va qu'au job préparé (jobId valide, non expiré, non consommé) ; l'ordre entier est borné par une échéance. */
async function runFill(order) {
  const j = job;
  if (!j || !order.jobId || j.id !== order.jobId || j.running || Date.now() > j.expires) {
    return { ok: false, reason: "aucune préparation valide pour ce fill (jobId inconnu, expiré ou déjà consommé) : appelle prepare d'abord" };
  }
  j.running = true;
  dropJob(); // consommé : un second fill avec le même jobId est refusé
  const { site, tabId } = j;
  const steps = [...j.steps];
  const deadline = Date.now() + (order.codeTimeoutSec + 45) * 1000;
  const ctl = { aborted: false };
  let timer = null;
  const expiry = new Promise(resolve => {
    timer = setTimeout(() => {
      ctl.aborted = true;
      resolve({ ok: false, steps, reason: `délai global de l'extension dépassé (${order.codeTimeoutSec + 45} s) : remplissage interrompu` });
    }, deadline - Date.now());
  });
  try {
    return await Promise.race([
      fillLogin(tabId, site, order.secret, {
        submitForm: order.submit, waitSecondFactor: order.waitCode, secondFactorTimeoutSec: order.codeTimeoutSec, steps, deadline, ctl,
      }),
      expiry,
    ]);
  } catch (e) {
    return { ok: false, steps, reason: safeError(e) };
  } finally {
    ctl.aborted = true;
    if (timer) clearTimeout(timer);
    order.secret.username = ""; order.secret.password = "";
  }
}

/** Ordre « waitCode » : reprend l'attente du code sur l'onglet du site, sans rien remplir (même déroulé que waitCode côté serveur). */
async function runWaitCode(order) {
  const site = normalizeSite(order.site);
  if (!site) return { ok: false, reason: "description du site invalide (domaine manquant ou loginUrl non https)" };
  const timeoutSec = order.timeoutSec;
  const steps = [];
  try {
    const tab = await findTab(site);
    if (!tab) return { ok: false, steps, reason: `Aucun onglet Chrome ouvert sur ${site.domain}.` };
    const tabId = tab.id;
    await bringToFront(tabId);
    const deadline = Date.now() + timeoutSec * 1000;
    let sf = await detectSecondFactor(tabId, site);
    // La page parle d'un code sans champ (choix de méthode, validation sur téléphone) : on laisse à l'utilisateur
    // le temps de faire apparaître le champ, sans le compter comme « code accepté ».
    while (sf && sf.kind === "texte-seul" && Date.now() < deadline) {
      await sleep(1000);
      if (!(await getTab(tabId))) break;
      sf = await detectSecondFactor(tabId, site);
    }
    const t = await getTab(tabId);
    const url = t ? publicUrl(t.url) : "", title = t ? t.title || "" : "";
    if (!sf) {
      steps.push("aucun code demandé sur cet onglet (la connexion est peut-être déjà passée)");
      return { ok: true, steps, url, title, secondFactor: null };
    }
    if (sf.kind === "texte-seul") {
      return { ok: false, steps, url, reason: `La page évoque un 2e facteur sans champ de saisie (${sf.detail}) : l'utilisateur doit d'abord choisir la méthode ou valider sur son téléphone. Rappelle sesame_wait_code ensuite.`, secondFactor: { pending: true, ...sf } };
    }
    steps.push(`reprise de l'attente (${sf.detail})`);
    const w = await waitForSecondFactor(tabId, site, { timeoutSec: Math.max(10, Math.round((deadline - Date.now()) / 1000)) });
    const t2 = await getTab(tabId);
    const url2 = t2 ? publicUrl(t2.url) : "", title2 = t2 ? t2.title || "" : "";
    if (!w.done) {
      const pending = w.reason === "délai dépassé";
      return {
        ok: false, steps, url: url2,
        reason: pending ? `L'utilisateur n'a pas saisi le code dans le délai (${timeoutSec} s). Rappelle sesame_wait_code quand il est prêt.` : `Attente du code interrompue : ${w.reason}.`,
        secondFactor: { pending, ...sf },
      };
    }
    steps.push(`code saisi par l'utilisateur, connexion poursuivie (${w.elapsedSec} s)`);
    return { ok: true, steps, url: url2, title: title2, secondFactor: { pending: false, ...sf } };
  } catch (e) {
    return { ok: false, steps, reason: safeError(e) };
  }
}

// ----------------------------------------------------------------------------------------------
// Popup (état de la liaison, test de connexion)
// ----------------------------------------------------------------------------------------------
function statusReport() {
  return { ...state, host: HOST, extensionId: chrome.runtime.id, version: VERSION };
}
/**
 * Test de connexion : (re)connecte le port natif et attend un instant. Un manifeste natif absent, un ID non
 * autorisé ou un pont qui s'arrête se signalent par une déconnexion immédiate avec un message d'erreur ;
 * un port toujours ouvert après ce délai signifie que Chrome a lancé le pont et qu'il tourne.
 */
async function testBridge() {
  if (!port) { backoffMs = 1000; await connectBridge(); }
  await sleep(1500);
  return statusReport();
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab || !msg || typeof msg.op !== "string") return; // seules les pages de l'extension (popup)
  if (msg.op === "status") { sendResponse(statusReport()); return; }
  if (msg.op === "test") { testBridge().then(sendResponse, () => sendResponse(statusReport())); return true; }
});

// ----------------------------------------------------------------------------------------------
// Démarrage : à chaque réveil du service worker, on (re)prend la liaison avec le pont.
// ----------------------------------------------------------------------------------------------
chrome.runtime.onStartup.addListener(connectBridge);
chrome.runtime.onInstalled.addListener(connectBridge);
connectBridge();
