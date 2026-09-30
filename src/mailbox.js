// Boîtes mail que Sésame peut LIRE pour y récupérer un code à usage unique (2FA), et rien d'autre.
//
// Principe : le code est un facteur d'authentification. Il ne doit jamais remonter à l'IA, ni au journal.
// Sésame va le chercher lui-même et le tape dans la page, exactement comme il tape un mot de passe.
//
// Où vivent les choses : la boîte est une entrée de sites.json portant un bloc `mailbox`
// ({ address, host, port }) et la politique « revoked » — ce n'est pas un site où l'on se connecte, et
// aucune demande de connexion ne doit la viser. Le mot de passe d'application est dans le Trousseau, sous
// la même clé que l'entrée, comme pour n'importe quel site (assistant signé, lecture silencieuse).
import { loadSites } from "./config.js";
import { getSecret, hasSecret } from "./keychain.js";
import { findLoginCode, checkMailbox } from "./imap.js";

/**
 * Google affiche un mot de passe d'application en quatre groupes de quatre lettres (« abcd efgh ijkl mnop ») ;
 * la valeur attendue par IMAP n'a pas ces espaces. On essaie TEL QUEL d'abord — un vrai mot de passe peut
 * contenir des espaces — et on ne retente sans espaces que si l'authentification a été refusée.
 */
async function withPassword(pass, fn) {
  try { return await fn(pass); }
  catch (e) {
    const squeezed = String(pass).replace(/\s+/g, "");
    if (squeezed && squeezed !== pass) return await fn(squeezed);
    throw e;
  }
}

/** Les boîtes configurées : [{ key, address, host, port }] — jamais de secret ici. */
export function mailboxes() {
  const sites = loadSites();
  return Object.entries(sites)
    .filter(([, s]) => s && s.mailbox && s.mailbox.address)
    .map(([key, s]) => ({ key, address: s.mailbox.address, host: s.mailbox.host || "imap.gmail.com", port: s.mailbox.port || 993 }))
    .filter(m => hasSecret(m.key));
}

/**
 * Indices permettant de reconnaître le message qui porte le code du site : son domaine enregistrable, ses
 * domaines supplémentaires, et son nom court. Sert à ne PAS saisir le code d'un autre service.
 */
export function hintsFor(site) {
  const out = new Set();
  if (site.domain) { out.add(String(site.domain).toLowerCase()); out.add(String(site.domain).split(".")[0].toLowerCase()); }
  for (const d of site.extraDomains || []) out.add(String(d).toLowerCase());
  if (site.key) out.add(String(site.key).toLowerCase());
  return [...out].filter(x => x.length >= 3);
}

/**
 * Cherche dans TOUTES les boîtes configurées un code pour ce site, arrivé depuis `since`.
 * Renvoie { code, from, subject, mailbox } ou null. Le `code` ne doit être ni journalisé ni renvoyé à l'IA :
 * l'appelant le tape dans la page et l'oublie. `from`/`subject` sont là pour le journal, sans le code.
 */
export async function findCodeForSite(site, since, { onEvent = () => {} } = {}) {
  const boxes = mailboxes();
  if (boxes.length === 0) return null;
  const hints = hintsFor(site);
  for (const box of boxes) {
    let creds;
    try { creds = getSecret(box.key); } catch { continue; }   // Trousseau indisponible : on passe
    try {
      const hit = await withPassword(creds.password, pass => findLoginCode({
        host: box.host, port: box.port, user: creds.username || box.address, pass,
        since, hints, maxMessages: 12, timeoutMs: 12000,
      }));
      creds.password = ""; creds.username = "";
      if (hit && hit.code) return { ...hit, mailbox: box.key };
    } catch (e) {
      if (creds) { creds.password = ""; creds.username = ""; }
      onEvent({ result: "erreur", detail: `boîte « ${box.key} » illisible : ${String(e.message || e).slice(0, 120)}` });
    }
  }
  return null;
}

/**
 * Le secret enregistré ressemble-t-il à un mot de passe d'application Google (seize lettres minuscules) ?
 * On ne regarde QUE sa forme, jamais sa valeur, et seulement pour pouvoir dire à l'utilisateur ce qui cloche
 * au lieu de le laisser recommencer à l'aveugle. Renvoie null si la question ne se pose pas (autre hébergeur).
 */
export function looksLikeAppPassword(key) {
  const box = mailboxes().find(m => m.key === key);
  if (!box || !/gmail\.com$|googlemail\.com$/i.test(box.host)) return null;
  let creds;
  try { creds = getSecret(key); } catch { return null; }
  const squeezed = String(creds.password || "").replace(/\s+/g, "");
  creds.password = ""; creds.username = "";
  return /^[a-z]{16}$/.test(squeezed);
}

/** Vérifie qu'une boîte répond (bouton « Vérifier » / `sesame doctor`). Ne lit aucun message. */
export async function verifyMailbox(key) {
  const box = mailboxes().find(m => m.key === key);
  if (!box) return { ok: false, message: `Aucune boîte « ${key} » configurée.` };
  let creds;
  try { creds = getSecret(key); } catch { return { ok: false, message: "Mot de passe de la boîte illisible dans le Trousseau." }; }
  try {
    return await withPassword(creds.password, async pass => {
      const r = await checkMailbox({ host: box.host, port: box.port, user: creds.username || box.address, pass, timeoutMs: 15000 });
      if (!r.ok) throw new Error(r.message);   // pour que le repli « sans espaces » soit tenté
      return r;
    });
  } catch (e) {
    return { ok: false, message: String(e.message || e).slice(0, 160) };
  } finally { creds.password = ""; creds.username = ""; }
}
