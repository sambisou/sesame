#!/usr/bin/env node
// Pont natif Sésame : relie l'extension Chrome « Sésame » (messagerie native, sur stdio) au serveur
// MCP (socket Unix ~/.sesame/bridge.sock). Lancé par Chrome via bin/sesame-bridge.sh ; meurt avec lui.
//
//   serveur MCP ──(JSON par ligne)──► socket ──► pont ──(4 octets LE + JSON)──► extension ──► page
//
// Règles :
//  - jamais de secret dans stderr ni dans une réponse d'erreur ; les champs username/password sont
//    effacés de la mémoire dès l'envoi à l'extension, et retirés de toute réponse relayée ;
//  - stdout est réservé au protocole natif (rien d'autre n'y est écrit) ;
//  - un seul pont actif : si un autre pont répond déjà sur la socket, celui-ci reste en attente sans
//    socket (le lien avec son Chrome est conservé) et réessaie toutes les 3 s ; une socket orpheline
//    (personne ne répond) est supprimée — mais un chemin qui n'est pas une socket, ou une socket qui
//    n'est pas à l'utilisateur, est refusé (arrêt) ;
//  - la socket n'est pas un contrôle d'accès (tout processus de la session peut s'y connecter) : c'est
//    le serveur qui authentifie ce pont par son pid (voir src/bridge-client.js) ; ce pont, lui, ne
//    laisse partir un secret vers l'extension que dans un « fill » portant le jobId d'un « prepare »
//    que l'extension a accepté (protocole en deux temps) ;
//  - umask 077 : la socket naît en 0600 ; ~/.sesame doit être en 0700 et à l'utilisateur, sinon arrêt.
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { HOME, ensureHome } from "../src/config.js";
import { BRIDGE_SOCK, bridgeRequest } from "../src/bridge-client.js";

process.umask(0o077); // avant toute création de fichier : la socket (et ~/.sesame s'il manque) naissent fermées aux autres

export const BRIDGE_VERSION = "0.5.0";
/** Chemin absolu de CE script tel qu'il tourne réellement — annoncé dans le pong pour que le client en
 *  vérifie le hash (src/bridge-client.js) ; ce n'est qu'une déclaration, jamais une preuve à elle seule. */
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PING_EXT_MS = 2000;            // délai de réponse de l'extension à un ping (le CLI, lui, attend 1 s le pont)
const PREPARE_MS = 150000;           // prepare : ouverture de page (30 s) + jusqu'à trois passages par la page de connexion
const GRACE_SEC = 90;                // marge ajoutée au délai du code pour attendre le « result »
const RETRY_MS = 3000;               // réessai d'acquisition de la socket en mode attente

const log = (...a) => { try { process.stderr.write("[sesame-bridge] " + a.join(" ") + "\n"); } catch {} };

// ---------------------------------------------------------------------------------------------
// Lien avec l'extension (messagerie native : 4 octets de longueur little-endian + JSON UTF-8).
// ---------------------------------------------------------------------------------------------
let extConnected = !process.stdin.isTTY; // lancé par Chrome : stdin est un tuyau, jamais un terminal
const pending = new Map();               // id → { resolve, timer }
let inBuf = Buffer.alloc(0);

function sendToExtension(msg) {
  const buf = Buffer.from(JSON.stringify(msg), "utf8");
  if (buf.length > 1024 * 1024) throw new Error("message trop long pour la messagerie native");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([head, buf]), () => buf.fill(0));
  // Le secret ne vit plus dans ce processus une fois parti vers l'extension.
  if ("username" in msg) msg.username = undefined;
  if ("password" in msg) msg.password = undefined;
}

/** Envoie `msg` (avec son `id`) à l'extension et attend la réponse portant le même id. L'erreur porte `sent` : la commande est-elle partie ? */
function askExtension(msg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const fail = (message, sent) => { const e = new Error(message); e.sent = sent; reject(e); };
    if (!extConnected) return fail("extension Sésame non connectée au pont", false);
    const timer = setTimeout(() => {
      pending.delete(msg.id);
      fail(`l'extension n'a pas répondu en ${Math.round(timeoutMs / 1000)} s`, true);
    }, timeoutMs);
    pending.set(msg.id, { resolve: r => { clearTimeout(timer); pending.delete(msg.id); resolve(r); } });
    try { sendToExtension(msg); } catch (e) { clearTimeout(timer); pending.delete(msg.id); fail(e.message, false); }
  });
}

function onExtensionMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if ((msg.type === "result" || msg.type === "ready" || msg.type === "pong") && pending.has(msg.id)) pending.get(msg.id).resolve(msg);
  // Tout autre message (salut de l'extension, id inconnu) est ignoré.
}

process.stdin.on("data", chunk => {
  inBuf = inBuf.length ? Buffer.concat([inBuf, chunk]) : chunk;
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (len > 64 * 1024 * 1024) { log("trame native aberrante, lien coupé"); return shutdown("trame invalide", 1); }
    if (inBuf.length < 4 + len) break;
    const body = inBuf.subarray(4, 4 + len);
    inBuf = inBuf.subarray(4 + len);
    let msg = null;
    try { msg = JSON.parse(body.toString("utf8")); } catch { log("message natif illisible (ignoré)"); }
    if (msg) onExtensionMessage(msg);
  }
});
process.stdin.on("end", () => shutdown("Chrome a fermé le lien"));
process.stdin.on("error", () => shutdown("erreur sur le lien Chrome"));
process.stdout.on("error", () => shutdown("erreur d'écriture vers Chrome"));

// ---------------------------------------------------------------------------------------------
// Socket Unix : commandes du serveur MCP (une ligne JSON → une ligne JSON, même id).
// ---------------------------------------------------------------------------------------------
let server = null;   // net.Server quand ce pont détient la socket
let closing = false;

/** Une page de connexion est en https, sauf hôte local (bancs d'essai) — même règle que assertLoginUrl côté serveur. */
function secureLoginUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  const local = ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
  return u.protocol === "https:" || (local && u.protocol === "http:");
}

/** Copie stricte de la description du site : rien d'autre ne part vers l'extension. null si le site est inacceptable (loginUrl non https). */
function pickSite(s) {
  const site = s && typeof s === "object" ? s : {};
  const sel = site.selectors && typeof site.selectors === "object" ? site.selectors : {};
  const domain = String(site.domain || "").toLowerCase().replace(/^www\./, "");
  if (!domain) return null;
  const loginUrl = String(site.loginUrl || `https://${domain}/`);
  if (!secureLoginUrl(loginUrl)) return null;
  const out = {
    key: String(site.key || domain), domain, loginUrl,
    selectors: Object.fromEntries(Object.entries(sel).filter(([, v]) => typeof v === "string" && v)),
  };
  if (Array.isArray(site.extraDomains) && site.extraDomains.length) out.extraDomains = site.extraDomains.map(String);
  return out;
}

/** Une réponse relayée ne transporte jamais un identifiant, même si l'extension se trompait. */
function stripSecrets(r) {
  if (!r || typeof r !== "object") return { ok: false, type: "result", reason: "réponse de l'extension illisible" };
  const { username, password, ...rest } = r; // eslint-disable-line no-unused-vars
  return rest;
}

async function handleLine(conn, line) {
  let req;
  try { req = JSON.parse(line); } catch { return reply(conn, null, { ok: false, type: "error", reason: "JSON invalide" }); }
  line = null;
  if (!req || typeof req !== "object") return reply(conn, null, { ok: false, type: "error", reason: "commande invalide" });
  const id = typeof req.id === "string" && req.id ? req.id : crypto.randomUUID();
  const type = String(req.type || "");

  if (type === "ping") {
    const pong = await askExtension({ id, type: "ping" }, PING_EXT_MS).catch(() => null);
    return reply(conn, id, { ok: true, type: "pong", extension: !!pong, version: pong?.version ?? null, bridge: BRIDGE_VERSION, pid: process.pid, script: SCRIPT_PATH });
  }
  if (type === "prepare" || type === "fill" || type === "waitCode") {
    if (!extConnected) return reply(conn, id, { ok: false, type: "error", reason: "extension Sésame non connectée au pont", sent: false });
    let msg, timeoutMs;
    if (type === "prepare") {
      const site = pickSite(req.site);
      if (!site) return reply(conn, id, { ok: false, type: "error", reason: "site refusé : domaine manquant ou loginUrl non https", sent: false });
      msg = { id, type, site };
      timeoutMs = PREPARE_MS;
    } else if (type === "fill") {
      const jobId = typeof req.jobId === "string" && /^[A-Za-z0-9-]{8,80}$/.test(req.jobId) ? req.jobId : null;
      if (!jobId) { req = null; return reply(conn, id, { ok: false, type: "error", reason: "fill sans jobId : appelle prepare d'abord", sent: false }); }
      const waitSec = Math.max(10, Number(req.codeTimeoutSec) || 180);
      msg = {
        id, type, jobId,
        username: String(req.username ?? ""), password: String(req.password ?? ""),
        submit: req.submit !== false, waitCode: req.waitCode !== false, codeTimeoutSec: waitSec,
      };
      timeoutMs = (waitSec + GRACE_SEC) * 1000;
    } else {
      const site = pickSite(req.site);
      if (!site) return reply(conn, id, { ok: false, type: "error", reason: "site refusé : domaine manquant ou loginUrl non https", sent: false });
      const waitSec = Math.max(10, Number(req.timeoutSec) || 180);
      msg = { id, type, site, timeoutSec: waitSec };
      timeoutMs = (waitSec + GRACE_SEC) * 1000;
    }
    req = null; // plus aucune référence au secret hors de `msg`, que sendToExtension efface
    try {
      const r = await askExtension(msg, timeoutMs);
      return reply(conn, id, stripSecrets(r));
    } catch (e) {
      return reply(conn, id, { ok: false, type: "error", reason: String(e.message || "erreur du pont").slice(0, 200), sent: !!e.sent });
    }
  }
  return reply(conn, id, { ok: false, type: "error", reason: `type de commande inconnu : ${type.slice(0, 40)}` });
}

function reply(conn, id, obj) {
  if (conn.destroyed) return;
  try { conn.write(JSON.stringify(id ? { id, ...obj } : obj) + "\n"); } catch {}
}

function onClient(conn) {
  conn.setEncoding("utf8");
  let buf = "";
  conn.on("data", chunk => {
    buf += chunk;
    if (buf.length > 1024 * 1024) { conn.destroy(); return; }
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) handleLine(conn, line).catch(() => reply(conn, null, { ok: false, type: "error", reason: "erreur interne du pont" }));
    }
  });
  conn.on("error", () => {});
}

/** Quelqu'un répond-il déjà sur la socket ? (pont actif d'un autre Chrome, ou socket orpheline) */
async function someoneAnswers() {
  try { await bridgeRequest({ type: "ping" }, { timeoutMs: 1500 }); return true; } catch { return false; }
}

/** ~/.sesame doit être un dossier à l'utilisateur, fermé aux autres (0700) : c'est lui qui protège la socket. */
function checkHome() {
  const st = fs.statSync(HOME);
  if (!st.isDirectory()) throw new Error(`${HOME} n'est pas un dossier`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${HOME} n'appartient pas à l'utilisateur`);
  if (st.mode & 0o077) throw new Error(`${HOME} est trop ouvert (mode ${(st.mode & 0o777).toString(8)}, attendu 700) : chmod 700 ${HOME}`);
}

/** Tente de prendre la socket. true = ce pont est actif ; false = un autre pont répond (rester en attente). */
async function acquireSocket() {
  ensureHome();
  checkHome();
  let st = null;
  try { st = fs.lstatSync(BRIDGE_SOCK); } catch {}
  if (st) {
    if (!st.isSocket()) throw new Error(`${BRIDGE_SOCK} existe et n'est pas une socket : refusé`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${BRIDGE_SOCK} n'appartient pas à l'utilisateur : refusé`);
    if (await someoneAnswers()) return false;
    try { fs.unlinkSync(BRIDGE_SOCK); log("socket orpheline supprimée"); } catch {}
  }
  return new Promise(resolve => {
    const srv = net.createServer(onClient);
    srv.on("error", () => resolve(false));
    srv.listen(BRIDGE_SOCK, () => {
      try { fs.chmodSync(BRIDGE_SOCK, 0o600); } catch {} // déjà 0600 par l'umask ; ceinture et bretelles
      server = srv;
      resolve(true);
    });
  });
}

function shutdown(why, code = 0) {
  if (closing) return;
  closing = true;
  extConnected = false;
  for (const [id, p] of pending) { pending.delete(id); p.resolve({ id, type: "error", ok: false, reason: `extension déconnectée (${why})`, sent: true }); }
  if (server) {
    server.close();
    try { fs.unlinkSync(BRIDGE_SOCK); } catch {}
  }
  log(`arrêt : ${why}`);
  setTimeout(() => process.exit(code), 200).unref();
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(`signal ${sig}`));
process.on("exit", () => { if (server) { try { fs.unlinkSync(BRIDGE_SOCK); } catch {} } });

// ---------------------------------------------------------------------------------------------
async function main() {
  let warned = false;
  while (!closing) {
    if (await acquireSocket()) { log(`pont actif (pid ${process.pid}) sur ${BRIDGE_SOCK}`); return; }
    if (!warned) { log("un autre pont Sésame est déjà actif : celui-ci attend sans ouvrir de socket"); warned = true; }
    if (!extConnected) return shutdown("lien Chrome absent, rien à attendre");
    await new Promise(r => setTimeout(r, RETRY_MS));
  }
}
main().catch(e => { log(`erreur fatale : ${String(e.message).slice(0, 200)}`); shutdown("erreur fatale", 1); });
