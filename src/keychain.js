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
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, KEYCHAIN_SERVICE } from "./config.js";
import { logEvent } from "./journal.js";
import { t } from "./i18n.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Chemins où chercher l'assistant Trousseau signé, dans l'ordre :
 * 1. le paquet DANS LEQUEL ce code s'exécute (Contents/Resources/sesame/src → Contents/MacOS) : c'est
 *    toujours le bon quand l'app est installée, déplacée, ou lancée depuis un disque monté ;
 * 2. l'app installée dans /Applications (cas du dépôt de développement) ;
 * 3. le build local du dépôt.
 */
function helperCandidates() {
  return [
    path.resolve(HERE, "..", "..", "..", "MacOS", "sesame-keychain"),
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

/** Délai maximal (s) accordé à une fenêtre du Trousseau avant de rendre la main avec une erreur claire. */
export const KEYCHAIN_WAIT_SEC = Math.max(10, Number(process.env.SESAME_KEYCHAIN_WAIT_SEC) || 45);

/** Marqueur lu par l'app Sésame (point sur l'icône + rangée « Sésame attend ton mot de passe macOS »). */
const WAITING_FILE = path.join(HOME, "keychain-waiting.json");

/**
 * L'assistant peut-il relire cet élément SANS fenêtre ? Ne déclenche jamais d'invite (commande `probe` de
 * l'assistant, interface du Trousseau désactivée). Renvoie "silent", "prompt" (élément lié à une autre
 * signature : à migrer), "absent", ou null si l'assistant manque ou ne connaît pas `probe` (version < 0.6.3).
 */
export function probeSecret(siteKey) {
  try { assertKey(siteKey); } catch { return null; }
  const helper = trustedHelperPath();
  if (!helper) return null;
  try {
    execFileSync(helper, ["probe", KEYCHAIN_SERVICE, siteKey], { stdio: "ignore", timeout: 10000 });
    return "silent";
  } catch (e) {
    if (e && e.status === 3) return "prompt";
    if (e && e.status === 44) return "absent";
    return null; // code 1 (usage : assistant trop ancien) ou délai
  }
}

/** Erreur typée : le Trousseau attendait une réponse de l'utilisateur et ne l'a pas eue dans le délai. */
export class KeychainWaitingError extends Error {
  constructor(siteKey, waitSec) {
    super(`Le Trousseau attend votre mot de passe macOS pour « ${siteKey} » (fenêtre du Trousseau, peut-être derrière les autres) : sans réponse après ${waitSec} s. Cliquez « Toujours autoriser » dans cette fenêtre, ou lancez « Re-migrer » dans le menu Sésame, puis redemandez la connexion.`);
    this.status = "attente_trousseau";
    this.site = siteKey;
  }
}

function markWaiting(siteKey) {
  try {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
    fs.writeFileSync(WAITING_FILE, JSON.stringify({ site: siteKey, ts: new Date().toISOString(), pid: process.pid, waitSec: KEYCHAIN_WAIT_SEC }), { mode: 0o600 });
  } catch {}
}
function clearWaiting() { try { fs.unlinkSync(WAITING_FILE); } catch {} }

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

/** Notification macOS, non bloquante (dupliquée de policy.js pour éviter un import circulaire). */
function notify(title, message) {
  if (process.platform !== "darwin") return;
  const esc = x => String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try { execFile("/usr/bin/osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`], () => {}); } catch {}
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
export function getSecret(siteKey, { caller = "mcp" } = {}) {
  assertKey(siteKey);
  const helper = trustedHelperPath();
  let out;
  if (helper) {
    // Sonde d'abord, sans fenêtre : si la lecture va demander une interaction (élément créé par une autre
    // signature de l'assistant), on prévient l'utilisateur AVANT (notification, marqueur pour l'app,
    // journal), et la lecture réelle est bornée dans le temps au lieu de pendre en silence.
    const state = probeSecret(siteKey);
    const willPrompt = state === "prompt";
    if (willPrompt) {
      logEvent({ site: siteKey, action: "keychain", caller, result: "attente", detail: `le Trousseau demande une interaction (élément lié à une autre signature) — fenêtre affichée, ${KEYCHAIN_WAIT_SEC} s au plus` });
      markWaiting(siteKey);
      notify(t("notif_keychain_title"), t("notif_keychain_message", { site: siteKey }));
    }
    try {
      out = execFileSync(helper, ["get", KEYCHAIN_SERVICE, siteKey], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: willPrompt ? KEYCHAIN_WAIT_SEC * 1000 : 30000, killSignal: "SIGKILL",
      });
      if (willPrompt) logEvent({ site: siteKey, action: "keychain", caller, result: "ok", detail: "réponse donnée dans la fenêtre du Trousseau" });
    } catch (e) {
      if (e && e.status === 44) throw new Error(`Aucun identifiant dans le Trousseau pour « ${siteKey} »`);
      if (e && (e.killed || e.signal === "SIGKILL")) {
        logEvent({ site: siteKey, action: "keychain", caller, result: "échec", detail: `délai du Trousseau dépassé (${KEYCHAIN_WAIT_SEC} s sans réponse)` });
        throw new KeychainWaitingError(siteKey, KEYCHAIN_WAIT_SEC);
      }
      if (willPrompt) logEvent({ site: siteKey, action: "keychain", caller, result: "refusé", detail: "refusé dans la fenêtre du Trousseau" });
      throw new Error(`Le Trousseau a refusé la lecture pour « ${siteKey} » (réponds « Autoriser » à sa demande, ou déverrouille-le)`);
    } finally {
      if (willPrompt) clearWaiting();
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
  // Depuis 0.6.3 : la sonde de l'assistant dit exactement si LUI (avec sa signature actuelle) relit en
  // silence — `dump-keychain` ne montre que des chemins, pas la signature, et classait à tort « migré »
  // un élément créé par une version ad hoc de l'assistant (fenêtre invisible du 28/09).
  const first = siteKeys.length ? probeSecret(siteKeys[0]) : null;
  if (first !== null) return siteKeys.filter(k => probeSecret(k) !== "silent");
  const trusted = trustedAppsByAccount();
  return siteKeys.filter(k => trusted[k] !== "helper");
}
