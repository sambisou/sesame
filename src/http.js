// Transport HTTP (« Streamable HTTP », standard MCP) pour les clients qui ne lancent pas
// de processus local : ChatGPT (connecteurs), agents distants, ou tout client MCP moderne.
// Écoute sur 127.0.0.1 uniquement. Chaque requête doit porter le jeton local (~/.sesame/http-token),
// soit en en-tête `Authorization: Bearer <jeton>`, soit dans le chemin `/mcp/<jeton>` pour les
// clients qui n'acceptent pas d'en-tête personnalisé. Aucun outil ne renvoie jamais un secret,
// et les règles par site (ask / always / revoked), le verrou et le journal s'appliquent à l'identique.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import { HOME, ensureHome } from "./config.js";
import { logEvent } from "./journal.js";

export const TOKEN_FILE = path.join(HOME, "http-token");
export const DEFAULT_PORT = 7433;

/** Jeton local, créé une fois, lisible seulement par l'utilisateur (0600). */
export function getOrCreateToken() {
  ensureHome();
  if (fs.existsSync(TOKEN_FILE)) {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 32) return t;
  }
  const t = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  return t;
}

export function rotateToken() {
  ensureHome();
  if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  return getOrCreateToken();
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Nom d'appelant journalisé et affiché : toujours préfixé « http: » pour qu'un client distant ne puisse pas se faire passer pour Cowork ou Claude Code. */
function callerFrom(req) {
  const raw = String(req.headers["x-sesame-caller"] || "");
  const name = raw.replace(/[^a-z0-9._-]/gi, "").slice(0, 24);
  return name ? `http:${name}` : "http";
}

/**
 * Démarre le serveur HTTP. Renvoie { server, url, token, close }.
 * @param {object} [o]
 * @param {number} [o.port=7433]  0 = port libre choisi par le système
 * @param {string} [o.host="127.0.0.1"]  ne pas exposer sur 0.0.0.0 : passe par un tunnel si besoin
 */
export async function serveHttp({ port = DEFAULT_PORT, host = "127.0.0.1" } = {}) {
  const token = getOrCreateToken();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const m = url.pathname.match(/^\/mcp(?:\/([A-Za-z0-9_-]+))?\/?$/);
    if (!m) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"chemin inconnu, utilise /mcp"}'); return; }

    const header = String(req.headers.authorization || "");
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : (m[1] || "");
    if (!presented || !safeEqual(presented, token)) {
      logEvent({ action: "http_refuse", caller: callerFrom(req), result: "refusé", detail: `jeton absent ou invalide depuis ${req.socket.remoteAddress}` });
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      res.end('{"error":"jeton Sésame requis (sesame serve affiche l\'URL complète)"}');
      return;
    }

    // Mode sans session : un serveur MCP par requête, isolé, sans état partagé.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = buildServer(callerFrom(req));
    res.on("close", () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e.message || e).split("\n")[0].slice(0, 200) })); }
    }
  });

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const actualPort = server.address().port;
  const base = `http://${host}:${actualPort}/mcp`;
  logEvent({ action: "http_start", caller: "cli", result: "ok", detail: `${base} (pid ${process.pid})` });
  return {
    server, token, url: base, urlWithToken: `${base}/${token}`,
    close: () => new Promise(r => server.close(() => r())),
  };
}
