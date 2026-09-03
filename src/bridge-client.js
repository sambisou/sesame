// Client de la socket Unix du pont natif (bin/sesame-bridge.js) : ping, prepare, fill, waitCode.
//
// Le pont est lancé par Chrome (messagerie native) et écoute ~/.sesame/bridge.sock. Le serveur MCP y
// envoie une commande JSON par ligne et lit une réponse JSON par ligne. Le secret transite par cette
// socket vers le pont, puis vers l'extension, puis vers la page : jamais vers l'IA.
//
// La socket n'est PAS un contrôle d'accès : tout processus de la session peut la créer avant le pont et
// répondre au ping. Avant d'y envoyer un secret, on authentifie donc le pair (authenticateBridge / openBridgeSession) :
//   1. ~/.sesame/bridge.sock est une socket, à l'utilisateur, en 0600 ;
//   2. le pong annonce un pid et un chemin de script (`script`) ;
//   3. lsof confirme que CE pid détient la socket (un usurpateur ne peut pas annoncer le pid du vrai
//      pont : celui-ci, en attente, ne détient aucune socket) ;
//   4. lsof confirme, par l'entrée « txt » (l'exécutable réellement mappé, non falsifiable — contrairement
//      à `process.title` ou à l'argv lu par `ps`), que ce pid exécute un binaire nommé `node` ;
//   5. le PARENT de ce pid (ppid via `ps`, puis son propre exécutable réel via lsof, tout aussi non
//      falsifiable) doit être un navigateur Chromium sous /Applications — c'est Chrome, jamais l'IA ni un
//      script quelconque, qui est censé lancer ce pont ;
//   6. le fichier annoncé par `script` doit avoir le même hash SHA-256 que bin/sesame-bridge.js de ce dépôt.
// Assouplissements 4b (parent `node` accepté) et 6b (script accepté n'importe où sous ~/.sesame, hash
// toujours vérifié) UNIQUEMENT si SESAME_TEST=1 est dans l'environnement DE CE PROCESSUS (jamais d'après
// ce que rapporte le pont) — réservé aux bancs d'essai (test/bridge.mjs, test/extension-live.mjs).
// Sinon : BridgeError « pont non authentifié », jamais de repli silencieux.
//
// Une seule connexion porte tout un échange : ping, authentification du pid, puis `prepare` et `fill`
// restent sur CETTE MÊME socket (voir openBridgeSession). Deux connexions distinctes pour prepare et fill
// laisseraient un attaquant remplacer la socket entre les deux et récupérer le fill authentifié par le
// premier échange ; avec une connexion unique, la remplacer ne change rien (le fd est déjà relié au vrai
// pont), et si CE pont meurt entre-temps, l'envoi échoue net — jamais de reconnexion silencieuse vers qui
// que ce soit d'autre.
//
// Protocole en deux temps : `prepare` (site → l'extension trouve ou ouvre l'onglet, vérifie le formulaire,
// répond « ready » avec un jobId valable 60 s) puis `fill` (jobId + secret). Le Trousseau n'est lu qu'entre
// les deux : le secret ne part que quand un formulaire a été vu sur un onglet du bon domaine.
//
// Aucun message d'erreur construit ici ne contient la charge envoyée.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOME } from "./config.js";

export const BRIDGE_SOCK = path.join(HOME, "bridge.sock");
/** Script du pont tel que ce dépôt le fournit : la référence dont le hash doit être retrouvé chez le pair. */
export const BRIDGE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "sesame-bridge.js");
const LSOF = "/usr/sbin/lsof";
const PS = "/bin/ps";
/** Chemins d'installation acceptés pour le parent (Chrome) du pont, hors bancs d'essai. */
const CHROMIUM_PARENT_RE = /^\/Applications\/(Google Chrome|Google Chrome Canary|Chromium|Brave Browser|Arc)\.app\/Contents\/MacOS\//;
const NODE_BASENAME_RE = /^node(?:\d+(?:\.\d+)*)?$/;

/** SESAME_TEST=1 dans l'environnement DE CE PROCESSUS (le client) — jamais d'après ce que le pont annonce. */
const testMode = () => process.env.SESAME_TEST === "1";

/** SESAME_BROWSER : auto (extension si elle répond, sinon Chrome Sésame), extension (jamais de second Chrome), chrome-profile (jamais l'extension). */
export const BROWSER_MODES = ["auto", "extension", "chrome-profile"];
export function browserMode() {
  const m = String(process.env.SESAME_BROWSER || "auto").trim().toLowerCase();
  return BROWSER_MODES.includes(m) ? m : "auto";
}

/**
 * Erreur de canal. `code` dit ce que l'appelant peut faire :
 *  - ENOENT / ECONNREFUSED / EACCES / "closed" / "bridge" / "timeout" / "socket" : rien n'a été transmis à
 *    l'extension → le serveur peut se replier sur le Chrome Sésame ;
 *  - "sent" : la commande (et le secret qu'elle portait) est partie et la réponse n'est pas venue →
 *    le formulaire a peut-être été rempli et soumis : PAS de repli, l'utilisateur vérifie l'onglet ;
 *  - "unauthenticated" : le pair n'est pas le pont Sésame → refus, jamais de repli.
 */
export class BridgeError extends Error {
  constructor(message, code = "bridge") { super(message); this.name = "BridgeError"; this.code = code; }
}

/**
 * Envoie une commande au pont et attend sa réponse (même `id`) sur une connexion neuve, refermée aussitôt.
 * Réservé aux échanges qui ne portent pas de secret (ping simple, waitCode) : `authenticateBridge` /
 * `openBridgeSession` ci-dessous exigent au contraire une connexion authentifiée puis réutilisée.
 * Rejette avec une BridgeError si la socket est absente, fermée, ou muette au-delà de `timeoutMs`,
 * ou si le pont répond lui-même par une erreur de canal (type "error").
 */
export function bridgeRequest(msg, { timeoutMs = 5000, carriesSecret = false } = {}) {
  return new Promise((resolve, reject) => {
    const id = typeof msg.id === "string" && msg.id ? msg.id : crypto.randomUUID();
    let buf = "";
    let done = false;
    let wrote = false;
    const sock = net.createConnection(BRIDGE_SOCK);
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(val);
    };
    const after = code => (wrote && carriesSecret ? "sent" : code);
    const timer = setTimeout(() => finish(new BridgeError(`le pont Sésame n'a pas répondu en ${Math.round(timeoutMs / 1000)} s`, after("timeout"))), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      const line = JSON.stringify({ ...msg, id }) + "\n";
      wrote = true; // dès l'appel : une écriture partielle compte comme envoyée
      sock.write(line);
    });
    sock.on("data", chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (r && r.id && r.id !== id) continue;
        if (r && r.type === "error") {
          const reason = String(r.reason || "erreur du pont").slice(0, 200);
          return finish(new BridgeError(reason, r.sent && carriesSecret ? "sent" : "bridge"));
        }
        return finish(null, r);
      }
    });
    sock.on("error", e => finish(new BridgeError(`socket du pont Sésame : ${e.code || "erreur"}`, after(e.code || "socket"))));
    sock.on("close", () => finish(new BridgeError(wrote ? "connexion au pont Sésame fermée sans réponse" : "connexion au pont Sésame fermée avant l'envoi", after("closed"))));
  });
}

/** { ok, extension, version, bridge, pid, script } si un pont répond, sinon null (jamais d'exception). */
export async function bridgePing({ timeoutMs = 4000 } = {}) {
  try {
    const r = await bridgeRequest({ type: "ping" }, { timeoutMs });
    return r && r.ok ? r : null;
  } catch { return null; }
}

/** L'extension Chrome est-elle prête (mode non « chrome-profile », pont joignable, extension connectée) ? */
export async function extensionReady() {
  if (browserMode() === "chrome-profile") return false;
  const p = await bridgePing();
  return !!(p && p.extension);
}

// ---------------------------------------------------------------------------------------------
// Authentification du pair
// ---------------------------------------------------------------------------------------------
function run(cmd, args, timeoutMs = 4000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout) => resolve(err && !stdout ? null : String(stdout || "")));
  });
}

/** La socket elle-même : type socket, à l'utilisateur, 0600. Lève une BridgeError sinon. */
export function assertSocketFile() {
  let st;
  try { st = fs.lstatSync(BRIDGE_SOCK); } catch (e) { throw new BridgeError(`socket du pont Sésame : ${e.code || "absente"}`, e.code || "ENOENT"); }
  if (!st.isSocket()) throw new BridgeError("pont non authentifié : bridge.sock n'est pas une socket", "unauthenticated");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new BridgeError("pont non authentifié : bridge.sock n'appartient pas à l'utilisateur", "unauthenticated");
  if ((st.mode & 0o777) !== 0o600) throw new BridgeError("pont non authentifié : bridge.sock n'est pas en 0600", "unauthenticated");
  return st;
}

/** `pid` détient-il la socket du pont ? (lsof -a -p pid -U -Fn : lignes « n<chemin> », restreintes aux sockets Unix). */
async function pidHoldsSocket(pid) {
  const out = await run(LSOF, ["-a", "-p", String(pid), "-U", "-Fn"]);
  if (out === null) return false;
  const names = out.split("\n").filter(l => l.startsWith("n")).map(l => l.slice(1).trim());
  return names.some(n => n === BRIDGE_SOCK || same(n, BRIDGE_SOCK));
}
const same = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return a === b; } };

/**
 * L'exécutable réellement mappé par `pid`, tel que lsof le voit (entrée FD « txt » : le binaire lui-même,
 * pas un fichier ouvert par le programme) — non falsifiable par `process.title` ni par l'argv qu'un
 * processus se choisit. Renvoie le chemin de la PREMIÈRE entrée « txt » (l'interpréteur), ou null.
 */
async function processTxtExecutable(pid) {
  const out = await run(LSOF, ["-p", String(pid), "-Ffn"]);
  if (out === null) return null;
  let fd = null;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tag = line[0], val = line.slice(1);
    if (tag === "f") fd = val;
    else if (tag === "n" && fd === "txt") return val;
  }
  return null;
}

/** ppid de `pid` via `ps`, ou null. */
async function parentPid(pid) {
  const out = await run(PS, ["-o", "ppid=", "-p", String(pid)]);
  if (!out || !out.trim()) return null;
  const n = Number(out.trim());
  return Number.isInteger(n) && n > 1 ? n : null;
}

function sha256File(p) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return null; }
}

/**
 * Vérifie que `pong` (annoncé par le pair sur la socket déjà authentifiée comme fichier — voir
 * assertSocketFile) décrit bien le pont Sésame. Quatre faits, tous vérifiés côté OS sauf le dernier :
 *  (a) le pid tient la socket (déjà vérifié par l'appelant via pidHoldsSocket) ;
 *  (b) l'exécutable réel du pid (lsof, entrée txt) est un binaire `node` ;
 *  (c) le PARENT du pid est un vrai navigateur Chromium sous /Applications (lsof sur le ppid) — en
 *      SESAME_TEST=1 seulement, un parent `node` est aussi accepté (bancs d'essai lancés sans Chrome) ;
 *  (d) le fichier annoncé par `pong.script` a le même hash SHA-256 que bin/sesame-bridge.js du dépôt — en
 *      SESAME_TEST=1 seulement, ce fichier peut être ailleurs que le script du dépôt, à condition d'être
 *      sous ~/.sesame (copie de banc d'essai) ; le hash reste exigé dans tous les cas.
 * Lève une BridgeError "unauthenticated" au premier fait qui ne tient pas.
 */
async function verifyPeer(pong) {
  const pid = Number(pong && pong.pid);
  if (!pong || !pong.ok || !Number.isInteger(pid) || pid <= 1) throw new BridgeError("pont non authentifié : le pong n'annonce pas de pid", "unauthenticated");
  if (pid === process.pid) throw new BridgeError("pont non authentifié : la socket est tenue par ce processus", "unauthenticated");
  if (!(await pidHoldsSocket(pid))) throw new BridgeError(`pont non authentifié : le pid ${pid} ne détient pas bridge.sock`, "unauthenticated");

  const exe = await processTxtExecutable(pid);
  if (!exe || !NODE_BASENAME_RE.test(path.basename(exe))) {
    throw new BridgeError(`pont non authentifié : le pid ${pid} n'exécute pas un binaire node (lsof)`, "unauthenticated");
  }

  const test = testMode();
  const ppid = await parentPid(pid);
  if (!ppid) throw new BridgeError(`pont non authentifié : parent du pid ${pid} introuvable (ps)`, "unauthenticated");
  const parentExe = await processTxtExecutable(ppid);
  if (!parentExe) throw new BridgeError(`pont non authentifié : exécutable du parent (pid ${ppid}) introuvable (lsof)`, "unauthenticated");
  const parentIsChromium = CHROMIUM_PARENT_RE.test(parentExe);
  const parentIsNode = test && NODE_BASENAME_RE.test(path.basename(parentExe));
  if (!parentIsChromium && !parentIsNode) {
    throw new BridgeError(`pont non authentifié : le parent (pid ${ppid}) n'est pas un navigateur Chromium`, "unauthenticated");
  }

  const scriptPath = typeof pong.script === "string" && pong.script ? pong.script : null;
  if (!scriptPath || !path.isAbsolute(scriptPath)) throw new BridgeError("pont non authentifié : le pong n'annonce pas de script", "unauthenticated");
  let real;
  try { real = fs.realpathSync(scriptPath); } catch { throw new BridgeError("pont non authentifié : script annoncé introuvable", "unauthenticated"); }
  let st;
  try { st = fs.statSync(real); } catch { throw new BridgeError("pont non authentifié : script annoncé introuvable", "unauthenticated"); }
  if (!st.isFile()) throw new BridgeError("pont non authentifié : script annoncé n'est pas un fichier", "unauthenticated");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new BridgeError("pont non authentifié : script annoncé n'appartient pas à l'utilisateur", "unauthenticated");
  if (st.mode & 0o022) throw new BridgeError("pont non authentifié : script annoncé modifiable par d'autres", "unauthenticated");
  const pathOk = same(real, BRIDGE_SCRIPT) || (test && real.startsWith(fs.realpathSync(HOME) + path.sep));
  if (!pathOk) throw new BridgeError("pont non authentifié : script annoncé hors du dépôt", "unauthenticated");
  const gotHash = sha256File(real), wantHash = sha256File(BRIDGE_SCRIPT);
  if (!wantHash) throw new BridgeError("pont non authentifié : bin/sesame-bridge.js du dépôt illisible (référence)", "unauthenticated");
  if (gotHash !== wantHash) throw new BridgeError("pont non authentifié : le script annoncé ne correspond pas à bin/sesame-bridge.js du dépôt (hash)", "unauthenticated");

  return { ppid, script: real };
}

// ---------------------------------------------------------------------------------------------
// Session authentifiée : une connexion, réutilisée pour prepare puis fill.
// ---------------------------------------------------------------------------------------------
class BridgeSession {
  constructor(sock) {
    this.sock = sock;
    this.buf = "";
    this.pending = new Map();
    this.closed = false;
    sock.setEncoding("utf8");
    sock.on("data", chunk => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        const id = r && r.id;
        if (!id || !this.pending.has(id)) continue;
        const entry = this.pending.get(id);
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (r.type === "error") {
          const reason = String(r.reason || "erreur du pont").slice(0, 200);
          entry.reject(new BridgeError(reason, r.sent && entry.carriesSecret ? "sent" : "bridge"));
        } else entry.resolve(r);
      }
    });
    sock.on("error", e => this._failAll(`socket du pont Sésame : ${e.code || "erreur"}`, e.code || "socket"));
    sock.on("close", () => this._failAll("connexion au pont Sésame fermée", "closed"));
  }

  _failAll(reason, baseCode) {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new BridgeError(reason, entry.wrote && entry.carriesSecret ? "sent" : baseCode));
    }
  }

  /** Envoie une commande sur cette connexion, déjà authentifiée, et attend sa réponse (même id). */
  send(msg, { timeoutMs = 5000, carriesSecret = false } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.sock.destroyed) return reject(new BridgeError("connexion au pont Sésame déjà fermée", "closed"));
      const id = typeof msg.id === "string" && msg.id ? msg.id : crypto.randomUUID();
      const entry = { resolve, reject, carriesSecret, wrote: false, timer: null };
      entry.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`le pont Sésame n'a pas répondu en ${Math.round(timeoutMs / 1000)} s`, entry.wrote && carriesSecret ? "sent" : "timeout"));
      }, timeoutMs);
      this.pending.set(id, entry);
      const line = JSON.stringify({ ...msg, id }) + "\n";
      entry.wrote = true; // dès l'appel : une écriture partielle compte comme envoyée
      this.sock.write(line, err => {
        if (!err) return;
        if (this.pending.has(id)) {
          this.pending.delete(id);
          clearTimeout(entry.timer);
          reject(new BridgeError(`écriture vers le pont Sésame : ${err.code || "erreur"}`, carriesSecret ? "sent" : (err.code || "socket")));
        }
      });
    });
  }

  /** Premier temps : l'extension trouve ou ouvre l'onglet et vérifie qu'un formulaire est visible. */
  prepare(payload, { timeoutMs = 160000 } = {}) {
    return this.send({ site: payload.site, type: "prepare" }, { timeoutMs });
  }

  /** Second temps, sur la MÊME connexion que prepare : le secret, vers le job préparé. */
  fill(payload, { timeoutMs } = {}) {
    const codeTimeoutSec = Number(payload.codeTimeoutSec) || 180;
    return this.send({ ...payload, type: "fill" }, { timeoutMs: timeoutMs ?? (codeTimeoutSec + 60) * 1000, carriesSecret: true });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.sock.destroy(); } catch {}
  }
}

function connectSession({ connectTimeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(BRIDGE_SOCK);
    const onError = e => { clearTimeout(timer); sock.destroy(); reject(new BridgeError(`socket du pont Sésame : ${e.code || "erreur"}`, e.code || "socket")); };
    const timer = setTimeout(() => { sock.removeListener("error", onError); sock.destroy(); reject(new BridgeError("connexion au pont Sésame : délai dépassé", "timeout")); }, connectTimeoutMs);
    sock.once("error", onError);
    sock.once("connect", () => { clearTimeout(timer); sock.removeListener("error", onError); resolve(new BridgeSession(sock)); });
  });
}

/**
 * Ouvre UNE connexion au pont, y envoie le ping, authentifie le pid (voir verifyPeer), et renvoie la
 * connexion encore ouverte — prête pour `session.prepare()` puis `session.fill()` sur cette même socket.
 * L'appelant DOIT fermer la session (`session.close()`) une fois l'échange terminé, y compris en cas
 * d'erreur après authentification. Lève une BridgeError ("unauthenticated" ou de canal) sinon, et ferme
 * elle-même la connexion dans ce cas.
 */
export async function openBridgeSession({ timeoutMs = 4000 } = {}) {
  assertSocketFile();
  const session = await connectSession();
  try {
    const pong = await session.send({ type: "ping" }, { timeoutMs });
    const info = await verifyPeer(pong);
    assertSocketFile(); // toujours la même socket, au même propriétaire, après les vérifications
    session.pong = pong;
    session.ppid = info.ppid;
    return session;
  } catch (e) {
    session.close();
    throw e;
  }
}

/**
 * Authentifie le pair sur une connexion neuve, le temps du contrôle, puis la referme. Utile pour un
 * simple diagnostic (`sesame doctor`, tests) qui n'a pas besoin d'enchaîner prepare/fill sur la même
 * socket. Renvoie le pong ({ pid, script, extension, version, … }).
 */
export async function authenticateBridge({ timeoutMs = 4000 } = {}) {
  const session = await openBridgeSession({ timeoutMs });
  const pong = session.pong;
  const ppid = session.ppid;
  session.close();
  return { ...pong, ppid };
}

// ---------------------------------------------------------------------------------------------
// Commandes ponctuelles sans secret (pas d'authentification nécessaire)
// ---------------------------------------------------------------------------------------------
/** Reprend l'attente du code dans l'onglet du site. `payload` = { site, timeoutSec }. Aucun secret : pas d'authentification nécessaire. */
export function bridgeWaitCode(payload, { timeoutMs } = {}) {
  const timeoutSec = Number(payload.timeoutSec) || 180;
  return bridgeRequest({ ...payload, type: "waitCode" }, { timeoutMs: timeoutMs ?? (timeoutSec + 60) * 1000 });
}
