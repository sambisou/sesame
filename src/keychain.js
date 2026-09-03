// Stockage des secrets dans le Trousseau macOS. Écriture (set/delete) ET lecture (get/has) passent par
// l'assistant Trousseau signé (macos/Sources/SesameKeychain, embarqué dans Sésame.app) quand il est
// présent ; repli sur l'outil système `security` sinon. Aucun secret n'est jamais écrit sur disque en
// clair par Sésame.
//
// Pourquoi l'assistant doit aussi ÉCRIRE (depuis 0.5.1) : un élément créé par /usr/bin/security — même
// avec `-T <chemin de l'assistant>` dans son ACL — porte une partition « apple-tool: » ; constat sur Mac
// réel, la lecture par l'assistant déclenche quand même la boîte du Trousseau (comportement macOS depuis
// Sierra, indépendant de l'ACL). Seul un élément créé PAR l'assistant lui-même (SecItemAdd, côté Swift)
// lui appartient au sens où macOS l'entend, et il peut alors le relire silencieusement.
//
// Élément créé avant 0.5.1 (par `security -T <assistant>` ou `-T ""`) : sa lecture déclenche encore la
// boîte de dialogue, même une fois l'assistant présent. Réenregistrer le site (`sesame add <site>` ou la
// fenêtre Sésame) le recrée via l'assistant et évite cette invite pour de bon.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KEYCHAIN_SERVICE } from "./config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Chemins où chercher l'assistant Trousseau signé, dans l'ordre : app installée, puis build local du dépôt. */
function helperCandidates() {
  return [
    "/Applications/Sésame.app/Contents/MacOS/sesame-keychain",
    path.join(HERE, "..", "macos", "build", "Sésame.app", "Contents", "MacOS", "sesame-keychain"),
  ];
}

/** Chemin de l'assistant Trousseau s'il est présent sur ce Mac, sinon null. */
export function helperPath() {
  return helperCandidates().find(p => fs.existsSync(p)) || null;
}

/**
 * Info assistant pour `sesame doctor` : présent ou non, chemin, et signé (`codesign -v`) ou non. Un
 * assistant présent mais non signé n'est jamais utilisé pour la confiance (setSecret retombe sur `-T ""`).
 */
export function trustedHelperInfo() {
  const p = helperPath();
  if (!p) return { present: false, path: null, signed: false };
  let signed = false;
  try { execFileSync("/usr/bin/codesign", ["-v", p], { stdio: "ignore" }); signed = true; } catch {}
  return { present: true, path: p, signed };
}

/** L'assistant, seulement s'il est présent ET signé — jamais utilisé sinon (ni pour écrire, ni pour lire). */
function trustedHelperPath() {
  const info = trustedHelperInfo();
  return info.present && info.signed ? info.path : null;
}

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

/**
 * Enregistre { username, password } pour un site (remplace s'il existe). Quand l'assistant signé est
 * présent, c'est LUI qui crée l'élément (`set`, valeur passée sur stdin, jamais en argv) : l'élément lui
 * appartient et il pourra le relire sans invite (voir la note en tête de fichier). Sinon, repli sur
 * `security -T ""` comme avant 0.5.1 (aucune application de confiance : chaque lecture demande).
 */
export function setSecret(siteKey, { username, password }) {
  assertKey(siteKey);
  const payload = JSON.stringify({ username, password });
  const helper = trustedHelperPath();
  if (helper) {
    try {
      execFileSync(helper, ["set", KEYCHAIN_SERVICE, siteKey], { input: payload, stdio: ["pipe", "pipe", "pipe"] });
      return;
    } catch (e) {
      const code = e && typeof e.status === "number" ? e.status : "?";
      throw new Error(`L'assistant Trousseau a refusé l'écriture pour « ${siteKey} » (code ${code}).`);
    }
  }
  // Supprimer puis recréer : `-U` conserverait l'ancienne liste d'applications de confiance.
  try { sec(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", siteKey]); } catch {}
  sec(["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", siteKey,
       "-l", `Sésame — ${siteKey}`, "-D", "Identifiants Sésame (Claude)", "-T", "", "-w", payload]);
}

/**
 * Lit le secret. Passe par l'assistant Trousseau signé quand il est présent (silencieux pour les éléments
 * créés avec `-T <assistant>` ; sinon le Trousseau demande, voir la note en tête de fichier) ; à défaut,
 * repli sur `security -w`. Renvoie { username, password } ou lève une erreur si absent/refusé.
 */
export function getSecret(siteKey) {
  assertKey(siteKey);
  const helper = trustedHelperPath();
  let out;
  if (helper) {
    try {
      out = execFileSync(helper, ["get", KEYCHAIN_SERVICE, siteKey], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      if (e && e.status === 44) throw new Error(`Aucun identifiant dans le Trousseau pour « ${siteKey} »`);
      throw new Error(`Le Trousseau a refusé la lecture pour « ${siteKey} » (réponds « Autoriser » à sa demande, ou déverrouille-le)`);
    }
  } else {
    try {
      out = sec(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", siteKey, "-w"]);
    } catch (e) {
      if (e.status === 44) throw new Error(`Aucun identifiant dans le Trousseau pour « ${siteKey} »`);
      throw new Error(`Le Trousseau a refusé la lecture pour « ${siteKey} » (réponds « Autoriser » à sa demande, ou déverrouille-le)`);
    }
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
  const helper = trustedHelperPath();
  if (helper) {
    try {
      execFileSync(helper, ["delete", KEYCHAIN_SERVICE, siteKey], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
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
    const helper = trustedHelperPath();
    if (helper) execFileSync(helper, ["has", KEYCHAIN_SERVICE, siteKey], { stdio: "ignore" });
    else sec(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", siteKey]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pour chaque site de Sésame : l'élément a-t-il une application de confiance ? Un seul `dump-keychain -a`
 * pour tous (lent : plusieurs dizaines de secondes sur un gros Trousseau). Renvoie { [siteKey]: résultat },
 * où résultat vaut : `false` (aucune application de confiance : le Trousseau demande à chaque lecture) ;
 * `"helper"` (seul l'assistant Trousseau signé est de confiance — le cas voulu depuis 0.5.0) ; `true`
 * (une autre application est de confiance — `/usr/bin/security`, un élément créé avant 0.3, ou « Toujours
 * autoriser » cliqué sur une ancienne invite : `sesame doctor` le signale, `sesame add <site>` corrige).
 * Les sites absents du résultat sont indéterminables. Sans argument, compare à l'assistant courant.
 */
export function trustedAppsByAccount(helperPath_ = helperPath()) {
  const out = {};
  // `security dump-keychain` rend les chemins en NFD (« é » = e + accent combinant) même quand le fichier
  // réel — et le chemin que Node lit du système de fichiers — est en NFC (un seul caractère « é ») : le dépôt
  // s'appelle « Sésame », donc TOUT chemin sous macos/build/Sésame.app traverse cette différence. Comparer
  // en NFC des deux côtés, sinon un élément parfaitement approuvé pour l'assistant serait à tort classé
  // « autre application » (avertissement de sécurité erroné).
  const helperNFC = helperPath_ ? helperPath_.normalize("NFC") : null;
  try {
    const dump = sec(["dump-keychain", "-a"]);
    for (const block of dump.split(/^keychain: /m)) {
      if (!block.includes(`"svce"<blob>="${KEYCHAIN_SERVICE}"`) || !block.includes("access:")) continue;
      const acct = block.match(/"acct"<blob>="([^"]+)"/)?.[1];
      if (!acct) continue;
      // Première entrée d'accès (decrypt) : « applications (N) » — N > 0 signifie qu'une application lit sans demander.
      const acl = block.split("access:", 2)[1];
      const m = acl.match(/applications \((\d+)\)/);
      const n = m ? Number(m[1]) : (/\/usr\/bin\/security/.test(acl) ? 1 : 0);
      out[acct] = n === 0 ? false : (helperNFC && acl.normalize("NFC").includes(helperNFC) ? "helper" : true);
    }
  } catch {}
  return out;
}

/** Variante pour un seul site (même coût qu'un dump complet) : true / "helper" / false / null si indéterminable. */
export function hasTrustedApp(siteKey) {
  try { assertKey(siteKey); } catch { return null; }
  const r = trustedAppsByAccount()[siteKey];
  return r === undefined ? null : r;
}

/**
 * Lit le secret par /usr/bin/security, JAMAIS par l'assistant : c'est le seul moyen de récupérer la valeur
 * d'un élément créé par l'ancien outil (avant 0.5.1), que l'assistant — même présent — ne peut pas relire
 * silencieusement puisqu'il ne lui appartient pas. Réservé à `sesame migrate-keychain` : déclenche la boîte
 * de dialogue du Trousseau (une fois par site, l'utilisateur clique « Autoriser »).
 */
export function readSecretViaSecurityTool(siteKey) {
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

/**
 * Parmi les clés données, celles dont l'élément Trousseau n'appartient pas à l'assistant (donc à migrer).
 * Un résultat indéterminable (absent du dump, Trousseau illisible) est traité comme « à migrer » : mieux
 * vaut une invite en trop qu'un site qui reste bloqué en silence sans qu'on sache pourquoi.
 */
export function sitesNeedingMigration(siteKeys) {
  const trusted = trustedAppsByAccount();
  return siteKeys.filter(k => trusted[k] !== "helper");
}
