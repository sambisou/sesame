// Chemins et fichier de configuration (non secret) : ~/.sesame/sites.json
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const HOME = path.join(process.env.SESAME_HOME || path.join(os.homedir(), ".sesame"));
export const SITES_FILE = path.join(HOME, "sites.json");
export const JOURNAL_FILE = path.join(HOME, "journal.jsonl");
export const LOCK_FILE = path.join(HOME, "LOCKED");
export const CHROME_PROFILE = path.join(HOME, "chrome-profile");
export const CDP_URL = process.env.SESAME_CDP_URL || "http://127.0.0.1:9222";
export const KEYCHAIN_SERVICE = process.env.SESAME_KEYCHAIN_SERVICE || "sesame";

export const POLICIES = ["always", "ask", "revoked"];

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

export function loadSites() {
  ensureHome();
  if (!fs.existsSync(SITES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SITES_FILE, "utf8"));
  } catch (e) {
    throw new Error(`sites.json illisible : ${e.message}`);
  }
}

export function saveSites(sites) {
  ensureHome();
  const tmp = SITES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sites, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, SITES_FILE);
}

export function getSite(name) {
  const sites = loadSites();
  const key = normalizeName(name);
  const site = sites[key];
  if (!site) throw new Error(`Site inconnu : « ${name} ». Sites connus : ${Object.keys(sites).join(", ") || "(aucun)"}`);
  return { key, ...site };
}

export function normalizeName(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

// Sous-domaines typiques d'une page de connexion : le site « vit » un cran au-dessus
// (login.infomaniak.com → infomaniak.com), sinon l'onglet après connexion ne serait plus reconnu.
const AUTH_LABELS = new Set(["login", "auth", "accounts", "account", "sso", "id", "idp", "signin", "sign-in", "connect", "oauth", "secure", "my", "mon", "espace-client", "espaceclient", "identity", "authentification", "authentication", "portal", "compte", "moncompte", "customer", "client"]);
/** Une page de connexion doit être en HTTPS (127.0.0.1 / localhost tolérés pour les bancs d'essai). Lève une erreur sinon. */
export function assertLoginUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error(`URL de connexion invalide : ${url || "(vide)"}`); }
  const local = ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
    throw new Error("La page de connexion doit être en https:// (un identifiant ne se tape jamais sur une page non chiffrée).");
  }
  return u;
}

// Suffixes publics à deux niveaux les plus courants : le domaine « du site » est un cran au-dessus.
const TWO_LEVEL_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "com.br", "com.mx", "co.za", "com.ar", "asso.fr", "gouv.fr", "com.tr", "co.in", "com.sg", "com.hk"]);

/**
 * Le domaine « du site » = domaine enregistrable (particulier.edf.fr → edf.fr, login.infomaniak.com →
 * infomaniak.com). Les flux de connexion sautent presque toujours d'un sous-domaine à l'autre
 * (espace-client., login., sso.) : c'est ce périmètre que Sésame accepte, jamais un autre domaine.
 */
export function siteDomainFor(url) {
  const h = hostnameOf(url);
  if (!h) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h === "localhost") return h;
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join(".");
  return TWO_LEVEL_SUFFIXES.has(last2) ? parts.slice(-3).join(".") : last2;
}

/** Le site correspond-il à cette URL d'onglet ? (domaine ou sous-domaine) */
export function siteMatchesUrl(site, url) {
  const h = hostnameOf(url);
  if (!h) return false;
  const domains = [site.domain, ...(site.extraDomains || [])].filter(Boolean);
  return domains.some(d => h === d || h.endsWith("." + d));
}
