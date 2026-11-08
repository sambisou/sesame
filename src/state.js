// Mémoire des sessions et des échecs par site : HOME/state/sessions.json (dossier 0700, fichier 0600,
// écriture atomique). Jamais de secret ici : des états, des dates, des codes de résultat, des URL
// publiques (origine + chemin). Sert la sonde (éviter de se connecter pour rien), le verrou d'essais
// (ne plus insister contre un captcha ou un mot de passe refusé) et `sesame state`.
import fs from "node:fs";
import path from "node:path";
import { HOME, loadSites } from "./config.js";
import { BLOCKING_CODES } from "./outcomes.js";

export const STATE_DIR = path.join(HOME, "state");
export const STATE_FILE = path.join(STATE_DIR, "sessions.json");

/** Sites qui bannissent vite un robot : un seul essai bloquant par jour, sauf réglage explicite du site. */
export const ONE_ATTEMPT_DOMAINS = Object.freeze(["booking.com", "beds24.com", "expediapartnercentral.com", "expediagroup.com"]);
const DEFAULT_ATTEMPTS = 2;
const MAX_FAILURES = 20;
/** Échecs qui ne disent rien de la session du site (Sésame, Chrome, Trousseau, politique) : l'état reste tel quel. */
export const NO_SESSION_INFO_CODES = Object.freeze([
  "fail.browser", "fail.extension", "fail.keychain_waiting", "fail.unexpected", "fail.uncertain",
  "fail.locked", "fail.revoked", "fail.access_refused", "fail.no_secret", "fail.unknown_site",
  "fail.domain_approval", "fail.tab_left",
]);

function ensureDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(STATE_DIR, 0o700); } catch {}
}

/** Tout l'état ({ [site]: {...} }). Fichier absent ou illisible → {} (on ne bloque jamais une connexion pour ça). */
export function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function writeState(state) {
  ensureDir();
  // Nom temporaire UNIQUE : deux processus (Claude Code, Cowork, app : chacun son serveur MCP) qui écrivent en
  // même temps ne tronquent plus le même `.tmp` avant le rename.
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

// Verrou d'écriture entre processus autour de lecture-modification-écriture (updateSite) : fichier créé en
// exclusif (`wx`), repris s'il a plus de LOCK_STALE_MS (processus mort), attendu au plus LOCK_WAIT_MS par pas
// de 25 ms (synchrone : l'appelant ne l'attend pas). Sans lui, A posait le verrou de booking pendant que B
// réécrivait l'état d'edf relu avant : le verrou était perdu.
const LOCK_PATH = STATE_FILE + ".lock";
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 1000;
const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
function acquireLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx", 0o600);
      try { fs.writeSync(fd, `${process.pid}\n`); } finally { fs.closeSync(fd); }
      return true;
    } catch (e) {
      if (e?.code !== "EEXIST") return false;   // dossier en lecture seule, etc. : on écrit sans verrou plutôt que rien
      try {
        const st = fs.statSync(LOCK_PATH);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.rmSync(LOCK_PATH, { force: true }); continue; }
      } catch { continue; }   // disparu entre-temps : on retente tout de suite
      if (Date.now() >= deadline) return false;
      sleepSync(25);
    }
  }
}
function releaseLock() { try { fs.rmSync(LOCK_PATH, { force: true }); } catch {} }

function blank() {
  return { state: "unknown", since: null, lastProbe: null, lastLogin: null, lastOutcome: null, lastCode: null, lastUrl: null, failures: [], lockedUntil: null, lockReason: null };
}

/** État d'un site (toujours un objet complet, jamais null). */
export function siteState(key) {
  const s = readState()[key];
  return { ...blank(), ...(s && typeof s === "object" ? s : {}), failures: Array.isArray(s?.failures) ? s.failures : [] };
}

/** Applique `fn` à l'état du site et réécrit le fichier, sous verrou inter-processus. Renvoie le nouvel état du site. */
function updateSite(key, fn) {
  ensureDir();
  const locked = acquireLock();
  try {
    const all = readState();
    const cur = { ...blank(), ...(all[key] || {}) };
    if (!Array.isArray(cur.failures)) cur.failures = [];
    const next = fn(cur) || cur;
    all[key] = next;
    writeState(all);
    return next;
  } finally {
    if (locked) releaseLock();
  }
}

function setState(cur, state, now) {
  if (!state || state === cur.state) return;
  cur.state = state;
  cur.since = now;
}

/** Résultat d'une sonde (probeSession) : alive | dead | unknown | challenge (ce dernier ne change pas l'état). */
export function recordProbe(key, state, url) {
  const now = new Date().toISOString();
  return updateSite(key, cur => {
    cur.lastProbe = now;
    if (["alive", "dead", "unknown"].includes(state)) setState(cur, state, now);
    if (url) cur.lastUrl = String(url).slice(0, 300);
    return cur;
  });
}

/** Plafond d'essais bloquants par jour civil pour ce site : site.limits.attemptsPerDay, sinon 1 pour les domaines qui bannissent, sinon 2. */
export function attemptsPerDay(site) {
  const n = Number(site?.limits?.attemptsPerDay);
  if (Number.isInteger(n) && n >= 1) return n;
  const domains = [site?.domain, ...(Array.isArray(site?.extraDomains) ? site.extraDomains : [])].filter(Boolean).map(d => String(d).toLowerCase());
  return domains.some(d => ONE_ATTEMPT_DOMAINS.some(o => d === o || d.endsWith("." + o))) ? 1 : DEFAULT_ATTEMPTS;
}

const localDay = iso => { const d = new Date(iso); return isNaN(d) ? null : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/** Nombre d'essais bloquants enregistrés aujourd'hui (jour civil, heure locale). */
export function attemptsToday(key, failures) {
  const list = Array.isArray(failures) ? failures : siteState(key).failures;
  const today = localDay(new Date().toISOString());
  return list.filter(f => f && localDay(f.ts) === today).length;
}

/** Prochain 09:30, heure locale : aujourd'hui si l'échec a lieu avant 09:30 (nuit), sinon le lendemain. */
export function nextMorning(from = new Date()) {
  const d = new Date(from);
  const today = new Date(from);
  today.setHours(9, 30, 0, 0);
  if (d < today) return today;
  d.setDate(d.getDate() + 1);
  d.setHours(9, 30, 0, 0);
  return d;
}

/** SESAME_NO_LOCK=1 : les bancs d'essai enchaînent des échecs volontaires sans poser de verrou (l'enregistrement, lui, a lieu). */
const lockDisabled = () => process.env.SESAME_NO_LOCK === "1";

/**
 * Enregistre la sortie de login() (ou waitCode()). `result` porte outcome/code/url. L'état devient alive
 * (ok.*), blocked (fail.rate_limited), dead (autre fail.*) ou reste inchangé (pending.*). Un code bloquant
 * (BLOCKING_CODES) s'ajoute aux 20 derniers échecs ; quand les échecs bloquants du jour atteignent le
 * plafond, lockedUntil = lendemain 09:30 et lockReason = ce code. `site` (facultatif) sert au plafond ;
 * sans lui, le site est relu dans sites.json.
 * Verdict PASSIF (`result.probe === true` : la sonde a vu un captcha, rien lu, rien soumis) : noté dans
 * lastCode, mais ni compté comme essai ni traduit en « dead » — l'onglet est en plein défi, pas déconnecté.
 * Un échec qui ne dit rien de la session (NO_SESSION_INFO_CODES : Chrome injoignable, Trousseau, refus,
 * onglet parti…) laisse aussi l'état tel quel : « dead » veut dire « le site a montré que la session est morte ».
 */
export function recordOutcome(key, result, site) {
  const code = String(result?.code || "");
  const out = result?.outcome || (result?.ok ? "ok" : "fail");
  const passive = result?.probe === true;
  const now = new Date().toISOString();
  return updateSite(key, cur => {
    cur.lastLogin = now;
    cur.lastOutcome = out;
    cur.lastCode = code || null;
    if (result?.url) cur.lastUrl = String(result.url).slice(0, 300);
    if (out === "ok") setState(cur, "alive", now);
    else if (code === "fail.rate_limited") setState(cur, "blocked", now);
    else if (out === "fail" && !passive && !NO_SESSION_INFO_CODES.includes(code)) setState(cur, "dead", now);
    if (BLOCKING_CODES.includes(code) && !passive) {
      cur.failures = [...cur.failures, { ts: now, code }].slice(-MAX_FAILURES);
      const limit = attemptsPerDay(site || (() => { try { return loadSites()[key]; } catch { return undefined; } })());
      if (!lockDisabled() && attemptsToday(key, cur.failures) >= limit) {
        cur.lockedUntil = nextMorning().toISOString();
        cur.lockReason = code;
      }
    }
    if (out === "ok" && cur.lockedUntil && new Date(cur.lockedUntil) <= new Date()) { cur.lockedUntil = null; cur.lockReason = null; }
    return cur;
  });
}

/** Le verrou d'essais est-il posé pour ce site ? `site` : objet (avec key) ou nom. → { locked, until, reason }. */
export function checkLock(site) {
  const key = typeof site === "string" ? site : site?.key;
  if (!key || lockDisabled()) return { locked: false, until: null, reason: null };
  const s = siteState(key);
  if (!s.lockedUntil) return { locked: false, until: null, reason: null };
  const until = new Date(s.lockedUntil);
  if (isNaN(until) || until <= new Date()) return { locked: false, until: null, reason: null };
  return { locked: true, until: until.toISOString(), reason: s.lockReason || s.lastCode || null };
}

/** Lève le verrou d'essais (sesame unlock-site) et oublie les échecs du jour : un essai redevient possible. */
export function unlockSite(key) {
  const today = localDay(new Date().toISOString());
  return updateSite(key, cur => {
    cur.lockedUntil = null;
    cur.lockReason = null;
    cur.failures = cur.failures.filter(f => localDay(f?.ts) !== today);
    if (cur.state === "blocked") setState(cur, "unknown", new Date().toISOString());
    return cur;
  });
}

/** Date lisible (heure locale) pour les messages : « 09/11 09:30 ». */
export function formatLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || "?");
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
