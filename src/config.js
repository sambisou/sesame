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
// Hébergeurs mutualisés et grands domaines à sous-domaines indépendants : chaque sous-domaine appartient à
// quelqu'un d'autre, le périmètre du site reste l'hôte entier (sinon foo.github.io ouvrirait bar.github.io).
const SHARED_SUFFIXES = new Set(["github.io", "gitlab.io", "pages.dev", "workers.dev", "herokuapp.com", "netlify.app", "vercel.app", "web.app", "firebaseapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "amazonaws.com", "myshopify.com", "wordpress.com", "blogspot.com", "notion.site", "wixsite.com", "squarespace.com", "webflow.io", "glitch.me", "repl.co", "fly.dev", "onrender.com", "surge.sh", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "github.com", "gitlab.com", "sharepoint.com", "google.com", "googleusercontent.com", "live.com", "apple.com", "icloud.com"]);
const MORE_TWO_LEVEL = ["me.uk", "ltd.uk", "plc.uk", "edu.au", "gov.au", "org.nz", "govt.nz", "ne.jp", "or.jp", "ac.jp", "go.jp", "net.in", "org.in", "com.cn", "net.cn", "org.cn", "gov.cn", "co.kr", "or.kr", "go.kr", "com.tw", "co.il", "org.il", "com.pl", "com.ua", "com.my", "com.ph", "com.vn", "com.eg", "com.sa", "com.co", "com.pe", "com.ve", "com.uy", "co.id", "com.pk", "com.bd", "com.ng", "co.ke", "com.gh"];
for (const s of MORE_TWO_LEVEL) TWO_LEVEL_SUFFIXES.add(s);

/** Périmètre d'un site : son domaine enregistrable (particulier.edf.fr → edf.fr), sauf hébergeurs mutualisés (hôte entier). */
export function siteDomainFor(url) {
  const h = hostnameOf(url);
  if (!h) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h === "localhost") return h;
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join("."), last3 = parts.slice(-3).join(".");
  if (SHARED_SUFFIXES.has(last2) || SHARED_SUFFIXES.has(last3)) return h;
  return TWO_LEVEL_SUFFIXES.has(last2) ? last3 : last2;
}

/** Le site correspond-il à cette URL d'onglet ? (domaine ou sous-domaine) */
export function siteMatchesUrl(site, url) {
  const h = hostnameOf(url);
  if (!h) return false;
  const domains = [site.domain, ...(site.extraDomains || [])].filter(Boolean);
  return domains.some(d => h === d || h.endsWith("." + d));
}

const IP_RE = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Valide un domaine supplémentaire (extraDomains) pour un site : accepte un domaine nu (edf.fr) ou une
 * URL/hôte (https://login.edf.fr/x, login.edf.fr) et en tire le domaine enregistrable (siteDomainFor).
 * Refuse : une IP non locale, le domaine principal du site lui-même, et les hébergeurs mutualisés
 * (SHARED_SUFFIXES) où chaque sous-domaine appartient à quelqu'un d'autre. Utilisé par `sesame add
 * --extra-domain`, `sesame_request_site` et l'apprentissage assisté (src/login.js). Renvoie
 * `{ domain }` si accepté, `{ error }` sinon (jamais les deux).
 */
export function validateExtraDomain(mainDomain, candidate) {
  const raw = String(candidate || "").trim().toLowerCase();
  if (!raw) return { error: "Domaine vide." };
  const asUrl = /^https?:\/\//.test(raw) ? raw : `https://${raw}/`;
  let domain;
  try { domain = siteDomainFor(asUrl); } catch { domain = null; }
  if (!domain) return { error: `Domaine invalide : « ${candidate} ».` };
  if (IP_RE.test(domain) && domain !== "127.0.0.1") return { error: `« ${domain} » est une adresse IP : refusé (sauf hôte local).` };
  if (domain === mainDomain) return { error: `« ${domain} » est déjà le domaine principal du site.` };
  if (SHARED_SUFFIXES.has(domain)) return { error: `« ${domain} » est un hébergeur mutualisé (chaque sous-domaine appartient à quelqu'un d'autre) : refusé.` };
  return { domain };
}
