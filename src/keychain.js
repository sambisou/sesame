// Stockage des secrets dans le Trousseau macOS via l'outil système `security`.
// Aucun secret n'est jamais écrit sur disque en clair par Sésame.
//
// Sécurité des éléments : ils sont créés avec `-T ""` (aucune application de confiance). Toute lecture
// du mot de passe — par Sésame comme par n'importe quel autre processus — déclenche donc la boîte de
// dialogue du Trousseau. Réponds « Autoriser » (jamais « Toujours autoriser », qui réinscrirait
// /usr/bin/security comme application de confiance et rendrait la lecture silencieuse pour tous).
import { execFileSync } from "node:child_process";
import { KEYCHAIN_SERVICE } from "./config.js";

/**
 * Exécute `security`. En cas d'échec, relance une erreur NEUTRE : jamais e.message de Node
 * (qui répète toute la ligne de commande, `-w <secret>` compris), seulement le code et le stderr
 * de `security`, qui ne contiennent pas le secret.
 */
function sec(args, input) {
  try {
    return execFileSync("/usr/bin/security", args, { input, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" });
  } catch (e) {
    const code = e && typeof e.status === "number" ? e.status : "?";
    const first = String(e?.stderr || "").split("\n").find(l => l.trim()) || "";
    const detail = first.replace(/^security:\s*/, "").replace(/\s-w\s.*$/, "").slice(0, 160) || "erreur inconnue";
    const err = new Error(`security ${args[0]} a échoué (code ${code}) : ${detail}`);
    err.status = code;
    throw err;
  }
}

export function keychainAvailable() {
  return process.platform === "darwin";
}

function assertKey(siteKey) {
  if (!/^[a-z0-9._-]{1,64}$/.test(String(siteKey))) throw new Error("Nom de site invalide pour le Trousseau.");
}

/** Enregistre { username, password } pour un site (remplace s'il existe, sans application de confiance). */
export function setSecret(siteKey, { username, password }) {
  assertKey(siteKey);
  const payload = JSON.stringify({ username, password });
  // Supprimer puis recréer : `-U` conserverait l'ancienne liste d'applications de confiance.
  try { sec(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", siteKey]); } catch {}
  sec(["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", siteKey,
       "-l", `Sésame — ${siteKey}`, "-D", "Identifiants Sésame (Claude)", "-T", "", "-w", payload]);
}

/** Lit le secret (le Trousseau demande ton accord). Renvoie { username, password } ou lève une erreur si absent/refusé. */
export function getSecret(siteKey) {
  assertKey(siteKey);
  let out;
  try {
    out = sec(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", siteKey, "-w"]);
  } catch (e) {
    if (e.status === 44) throw new Error(`Aucun identifiant dans le Trousseau pour « ${siteKey} »`);
    throw new Error(`Le Trousseau a refusé la lecture pour « ${siteKey} » (réponds « Autoriser » à sa demande, ou déverrouille-le)`);
  }
  try {
    const obj = JSON.parse(out.trim());
    if (typeof obj.password !== "string") throw new Error();
    return { username: obj.username ?? "", password: obj.password };
  } catch {
    throw new Error(`Secret du Trousseau illisible pour « ${siteKey} »`);
  }
}

export function deleteSecret(siteKey) {
  assertKey(siteKey);
  try {
    sec(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", siteKey]);
    return true;
  } catch {
    return false;
  }
}

/** Présence de l'élément, sans lire le mot de passe (ne déclenche aucune demande du Trousseau). */
export function hasSecret(siteKey) {
  try {
    assertKey(siteKey);
    sec(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", siteKey]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pour chaque site de Sésame : l'élément a-t-il une application de confiance (créé avant 0.3, ou « Toujours
 * autoriser » cliqué) ? Un seul `dump-keychain -a` pour tous (lent : plusieurs dizaines de secondes sur un gros
 * Trousseau). Renvoie { [siteKey]: true | false } ; les sites absents du résultat sont indéterminables.
 */
export function trustedAppsByAccount() {
  const out = {};
  try {
    const dump = sec(["dump-keychain", "-a"]);
    for (const block of dump.split(/^keychain: /m)) {
      if (!block.includes(`"svce"<blob>="${KEYCHAIN_SERVICE}"`) || !block.includes("access:")) continue;
      const acct = block.match(/"acct"<blob>="([^"]+)"/)?.[1];
      if (!acct) continue;
      // Première entrée d'accès (decrypt) : « applications (N) » — N > 0 signifie qu'une application lit sans demander.
      const acl = block.split("access:", 2)[1];
      const m = acl.match(/applications \((\d+)\)/);
      out[acct] = m ? Number(m[1]) > 0 : /\/usr\/bin\/security/.test(acl);
    }
  } catch {}
  return out;
}

/** Variante pour un seul site (même coût qu'un dump complet) : true / false / null si indéterminable. */
export function hasTrustedApp(siteKey) {
  try { assertKey(siteKey); } catch { return null; }
  const r = trustedAppsByAccount()[siteKey];
  return r === undefined ? null : r;
}
