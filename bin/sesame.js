#!/usr/bin/env node
// CLI Sésame — l'interface de l'utilisateur. Les secrets sont saisis ici, au clavier, jamais via Claude.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  HOME, SITES_FILE, JOURNAL_FILE, CHROME_PROFILE, CDP_URL, POLICIES,
  loadSites, saveSites, normalizeName, siteDomainFor, assertLoginUrl, ensureHome,
} from "../src/config.js";
import { setSecret, deleteSecret, hasSecret, trustedAppsByAccount, keychainAvailable } from "../src/keychain.js";
import { readJournal, formatEvent, logEvent } from "../src/journal.js";
import { lock, unlock, isLocked, assertPolicy } from "../src/policy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_BIN = path.join(ROOT, "bin", "sesame-mcp.js");
const [, , cmd, ...args] = process.argv;

const HELP = `Sésame — coffre d'identifiants local pour Claude

Usage : sesame <commande> [options]

  add <site> [--url <url-de-connexion>] [--policy ask|always] [--user-sel <css>] [--pass-sel <css>] [--submit-sel <css>] [--code-sel <css>] [--note <texte>]
                          Enregistre un site ; demande identifiant + mot de passe au clavier (masqué).
  list                    Liste les sites, leur politique et leur dernière utilisation.
  policy <site> <ask|always|revoked>
                          Change la politique : ask = l'utilisateur valide à chaque fois (défaut),
                          always = automatique, revoked = accès coupé.
  revoke <site>           Raccourci de : policy <site> revoked
  remove <site>           Supprime le site ET son secret du Trousseau.
  lock | unlock           Verrou global : bloque toute connexion, quel que soit le site.
  log [--site <site>] [-n <N>]
                          Affiche le journal d'accès (défaut : 30 dernières lignes).
  chrome                  Lance le Chrome « Sésame » (profil dédié, port DevTools ${CDP_URL.split(":").pop()}).
  install [claude-code|cowork|desktop|all]
                          Ajoute Sésame comme serveur MCP à Claude Code et/ou Claude Desktop (Cowork).
  install <codex|gemini|cursor|vscode|windsurf|chatgpt|print>
                          Affiche la configuration à coller pour un autre client MCP (rien n'est écrit).
  install extension [--id <id>] [--browser chrome|brave|arc|chromium|canary]
                          Extension Chrome « Sésame » (bêta), pour ton Chrome habituel. Sans --id : marche
                          à suivre. Avec --id : écrit le manifeste de messagerie native (0600) pour le seul
                          navigateur demandé (défaut : chrome).
  serve [--port <n>]      Sert Sésame en HTTP local (Streamable HTTP, jeton obligatoire) pour les clients
                          qui ne lancent pas de processus : ChatGPT via tunnel, agents distants, etc.
  token [--rotate]        Affiche (ou renouvelle) le jeton du serveur HTTP.
  doctor                  Vérifie l'installation (Trousseau, Chrome, extension, sites, verrou).
  help                    Cette aide.

Dossier : ${HOME}
`;

async function main() {
  switch (cmd) {
    case undefined: case "help": case "-h": case "--help": return console.log(HELP);
    case "add": return add();
    case "list": case "ls": return list();
    case "policy": return policy(args[0], args[1]);
    case "revoke": return policy(args[0], "revoked");
    case "remove": case "rm": return remove(args[0]);
    case "lock": lock(); logEvent({ action: "lock", caller: "cli", result: "ok" }); return console.log("🔒 Sésame verrouillé. Aucune connexion ne sera remplie jusqu'à `sesame unlock`.");
    case "unlock": unlock(); logEvent({ action: "unlock", caller: "cli", result: "ok" }); return console.log("🔓 Sésame déverrouillé.");
    case "log": case "journal": return log();
    case "chrome": return chrome();
    case "install": return install(args[0] || "all");
    case "serve": return serve();
    case "token": return token();
    case "doctor": return doctor();
    default: console.error(`Commande inconnue : ${cmd}\n`); console.log(HELP); process.exit(1);
  }
}

function opt(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

function prompt(question, { hidden = false } = {}) {
  if (!hidden) {
    return new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, a => { rl.close(); resolve(a); });
    });
  }
  // Saisie masquée : mode brut, rien n'est affiché, Backspace géré, Ctrl-C abandonne.
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const onData = ch => {
      const c = ch.toString("utf8");
      for (const k of c) {
        if (k === "\r" || k === "\n") { done(); return; }
        if (k === "\u0003") { cleanup(); process.stdout.write("\n"); reject(new Error("Abandon (Ctrl-C).")); return; }
        if (k === "\u007f" || k === "\b") { buf = buf.slice(0, -1); continue; }
        buf += k;
      }
    };
    const cleanup = () => { stdin.removeListener("data", onData); if (stdin.isTTY) stdin.setRawMode(!!wasRaw); stdin.pause(); };
    const done = () => { cleanup(); process.stdout.write("\n"); resolve(buf); };
    stdin.on("data", onData);
  });
}

async function add() {
  const name = args[0];
  if (!name || name.startsWith("--")) throw new Error("Usage : sesame add <site> --url <url-de-connexion>");
  if (!keychainAvailable()) throw new Error("Sésame stocke les secrets dans le Trousseau macOS : cette commande ne fonctionne que sur Mac.");
  const key = normalizeName(name);
  const sites = loadSites();
  const existing = sites[key] || {};
  const url = opt("--url") || existing.loginUrl || (await prompt(`URL de la page de connexion de « ${key} » : `)).trim();
  assertLoginUrl(url);
  const domain = siteDomainFor(url);
  if (!domain) throw new Error(`URL invalide : ${url}`);
  const policyV = opt("--policy") || existing.policy || "ask";
  assertPolicy(policyV);
  if (policyV === "revoked") throw new Error("Une politique « revoked » n'a pas de sens à la création.");

  console.log(`\nIdentifiants pour « ${key} » (${domain}). Ils vont directement dans le Trousseau macOS ; Claude ne les verra jamais.`);
  const username = (await prompt("Identifiant / e-mail (vide si le site n'en demande pas) : ")).trim();
  const password = await prompt("Mot de passe : ", { hidden: true });
  if (!password) throw new Error("Mot de passe vide : abandon.");
  const confirm = await prompt("Confirmer le mot de passe : ", { hidden: true });
  if (password !== confirm) throw new Error("Les deux saisies diffèrent : abandon.");

  setSecret(key, { username, password });
  sites[key] = {
    domain,
    loginUrl: url,
    policy: policyV,
    note: opt("--note") || existing.note,
    selectors: {
      username: opt("--user-sel") || existing.selectors?.username,
      password: opt("--pass-sel") || existing.selectors?.password,
      submit: opt("--submit-sel") || existing.selectors?.submit,
      code: opt("--code-sel") || existing.selectors?.code,
    },
    createdAt: existing.createdAt || new Date().toISOString(),
    lastUsed: existing.lastUsed,
  };
  saveSites(sites);
  logEvent({ site: key, action: existing.domain ? "update_site" : "add_site", caller: "cli", result: "ok", detail: `${domain}, politique ${policyV}` });
  console.log(`\n✅ « ${key} » enregistré (${domain}, politique « ${policyV} »).`);
  console.log(`   Dis simplement à Claude : « connecte-toi sur ${key} » — il appellera sesame_login.`);
}

function list() {
  const sites = loadSites();
  const keys = Object.keys(sites).sort();
  if (isLocked()) console.log("🔒 VERROU GLOBAL ACTIF (sesame unlock)\n");
  if (keys.length === 0) return console.log("Aucun site. Ajoute-en un : sesame add edf --url https://…");
  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log(pad("SITE", 16) + pad("DOMAINE", 32) + pad("POLITIQUE", 10) + pad("SECRET", 8) + "DERNIÈRE UTILISATION");
  for (const k of keys) {
    const s = sites[k];
    const icon = { ask: "🟡 ask", always: "🟢 always", revoked: "🔴 revoked" }[s.policy] || s.policy;
    const secret = keychainAvailable() ? (hasSecret(k) ? "oui" : "NON") : "?";
    console.log(pad(k, 16) + pad(s.domain, 32) + pad(icon, 10) + pad(secret, 8) + (s.lastUsed ? s.lastUsed.replace("T", " ").slice(0, 16) : "jamais"));
  }
}

function policy(name, p) {
  if (!name || !p) throw new Error("Usage : sesame policy <site> <ask|always|revoked>");
  assertPolicy(p);
  const key = normalizeName(name);
  const sites = loadSites();
  if (!sites[key]) throw new Error(`Site inconnu : ${key}`);
  const before = sites[key].policy;
  sites[key].policy = p;
  saveSites(sites);
  logEvent({ site: key, action: "policy", caller: "cli", result: "ok", detail: `${before} → ${p}` });
  console.log(`✅ « ${key} » : ${before} → ${p}`);
}

function remove(name) {
  if (!name) throw new Error("Usage : sesame remove <site>");
  const key = normalizeName(name);
  const sites = loadSites();
  const existed = !!sites[key];
  delete sites[key];
  saveSites(sites);
  const secretGone = keychainAvailable() ? deleteSecret(key) : false;
  logEvent({ site: key, action: "remove_site", caller: "cli", result: "ok", detail: `config ${existed ? "supprimée" : "absente"}, secret ${secretGone ? "supprimé" : "absent"}` });
  console.log(`🗑  « ${key} » : configuration ${existed ? "supprimée" : "absente"}, secret du Trousseau ${secretGone ? "supprimé" : "absent"}.`);
}

function log() {
  const n = Number(opt("-n") || opt("--limit") || 30);
  const site = opt("--site");
  const events = readJournal({ site: site ? normalizeName(site) : undefined, limit: n });
  if (events.length === 0) return console.log("Journal vide.");
  for (const e of events) console.log(formatEvent(e));
  console.log(`\n(${JOURNAL_FILE})`);
}

function chromeBinary() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ];
  return candidates.find(p => fs.existsSync(p));
}

function chrome() {
  const bin = chromeBinary();
  if (!bin) throw new Error("Google Chrome introuvable dans /Applications.");
  ensureHome();
  fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  const port = CDP_URL.split(":").pop();
  const child = spawn(bin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    "--no-first-run", "--no-default-browser-check",
    "--password-store=basic",
  ], { detached: true, stdio: "ignore" });
  child.unref();
  logEvent({ action: "chrome_start", caller: "cli", result: "ok", detail: `port ${port}` });
  console.log(`🌐 Chrome « Sésame » lancé (profil ${CHROME_PROFILE}, DevTools sur ${CDP_URL}).`);
  console.log("   Première fois : installe l'extension « Claude in Chrome » dans CE profil, puis connecte-la à Claude Desktop.");
}

function nodeBin() { return process.execPath; }

async function serve() {
  const { serveHttp, DEFAULT_PORT: DP } = await import("../src/http.js");
  const port = Number(opt("--port") || DP);
  const s = await serveHttp({ port });
  console.log(`🔌 Sésame en HTTP sur ${s.url} (127.0.0.1 seulement, Streamable HTTP).`);
  console.log(`   En-tête : Authorization: Bearer ${s.token}`);
  console.log(`   Ou URL avec jeton : ${s.urlWithToken}`);
  console.log("   Ctrl-C pour arrêter. Renouveler le jeton : sesame token --rotate");
  await new Promise(() => {});
}

async function token() {
  const { getOrCreateToken, rotateToken, TOKEN_FILE } = await import("../src/http.js");
  const t = args.includes("--rotate") ? rotateToken() : getOrCreateToken();
  if (args.includes("--rotate")) logEvent({ action: "http_token_rotate", caller: "cli", result: "ok" });
  console.log(t);
  console.error(`(fichier : ${TOKEN_FILE})`);
}

const SNIPPET_TARGETS = ["codex", "gemini", "cursor", "vscode", "windsurf", "chatgpt", "print"];

/** Configurations à coller pour les clients MCP que Sésame n'écrit pas lui-même. */
function printSnippets(target) {
  const node = nodeBin();
  const stdio = caller => ({ command: node, args: [MCP_BIN, caller] });
  const j = o => JSON.stringify(o, null, 2);
  const blocks = {
    codex: `# Codex CLI (OpenAI) — ~/.codex/config.toml
[mcp_servers.sesame]
command = "${node}"
args = ["${MCP_BIN}", "codex"]`,
    gemini: `# Gemini CLI (Google) — ~/.gemini/settings.json
${j({ mcpServers: { sesame: stdio("gemini") } })}`,
    cursor: `# Cursor — ~/.cursor/mcp.json (global) ou .cursor/mcp.json (projet)
${j({ mcpServers: { sesame: stdio("cursor") } })}`,
    vscode: `# VS Code (GitHub Copilot, mode agent) — .vscode/mcp.json ou réglage utilisateur « mcp »
${j({ servers: { sesame: { type: "stdio", ...stdio("vscode") } } })}`,
    windsurf: `# Windsurf — ~/.codeium/windsurf/mcp_config.json
${j({ mcpServers: { sesame: stdio("windsurf") } })}`,
    chatgpt: `# ChatGPT (connecteur MCP, mode développeur) — ChatGPT ne lance pas de processus local :
# 1. sesame serve            → serveur HTTP local avec jeton
# 2. expose-le en HTTPS via un tunnel (ex. cloudflared tunnel --url http://127.0.0.1:7433)
# 3. dans ChatGPT : Réglages → Connecteurs → Créer, URL = https://<ton-tunnel>/mcp/<jeton>, authentification : aucune
# ⚠️  Toute personne qui connaît cette URL peut demander des connexions (validées par toi, journalisées,
#     sans jamais obtenir un secret). Renouvelle le jeton avec : sesame token --rotate. Non testé par l'auteur.`,
  };
  const keys = target === "print" ? Object.keys(blocks) : [target];
  for (const k of keys) console.log(blocks[k] + "\n");
}

const NATIVE_HOST_NAME = "app.sesamekey.bridge";
const EXTENSION_ID_RE = /^[a-p]{32}$/;
const BRIDGE_SOCKET = path.join(HOME, "bridge.sock");
const EXTENSION_DIR = path.join(ROOT, "extension");
const BRIDGE_SH = path.join(ROOT, "bin", "sesame-bridge.sh");

/** Dossiers « NativeMessagingHosts » des navigateurs basés sur Chromium, sur macOS (clé = valeur de --browser). */
function nativeMessagingDirs() {
  const base = path.join(os.homedir(), "Library/Application Support");
  return [
    { key: "chrome", name: "Google Chrome", dir: path.join(base, "Google/Chrome/NativeMessagingHosts") },
    { key: "canary", name: "Chrome Canary", dir: path.join(base, "Google/Chrome Canary/NativeMessagingHosts") },
    { key: "chromium", name: "Chromium", dir: path.join(base, "Chromium/NativeMessagingHosts") },
    { key: "brave", name: "Brave", dir: path.join(base, "BraveSoftware/Brave-Browser/NativeMessagingHosts") },
    { key: "arc", name: "Arc", dir: path.join(base, "Arc/User Data/NativeMessagingHosts") },
  ];
}

/**
 * `sesame install extension [--id <id>] [--browser <clé>]` : marche à suivre sans --id ; avec --id, écrit le
 * manifeste de messagerie native (0600) pour le SEUL navigateur demandé (défaut chrome) — pas de manifeste
 * dans un navigateur où l'extension n'est pas chargée.
 */
function installExtension(id, browser = "chrome") {
  if (!id) {
    console.log(`Extension Chrome « Sésame » (bêta) — pour ton Chrome habituel, sans second profil.

1. Ouvre chrome://extensions
2. Active le « Mode développeur » (en haut à droite)
3. Clique « Charger l'extension non empaquetée » et choisis ce dossier :
   ${EXTENSION_DIR}
4. Copie l'ID affiché sous le nom de l'extension (32 lettres entre a et p)
5. Relance : sesame install extension --id <cet-id>   (ajoute --browser brave|arc|chromium|canary si ce n'est pas Chrome)
6. Recharge l'extension (bouton ↻ sur sa carte), ouvre son popup, clique « Tester la connexion »

« sesame doctor » vérifie ensuite : manifeste présent, pont joignable, extension connectée.`);
    return;
  }
  const key = String(id).trim().toLowerCase();
  if (!EXTENSION_ID_RE.test(key)) throw new Error(`ID d'extension invalide : « ${id} ». Un ID Chrome fait 32 lettres entre a et p, copié depuis chrome://extensions.`);
  const target = nativeMessagingDirs().find(b => b.key === String(browser || "chrome").trim().toLowerCase());
  if (!target) throw new Error(`Navigateur inconnu : « ${browser} ». Valeurs acceptées pour --browser : chrome (défaut), brave, arc, chromium, canary.`);
  if (!fs.existsSync(path.dirname(target.dir))) throw new Error(`${target.name} ne semble pas installé (dossier ${path.dirname(target.dir)} absent).`);
  if (!fs.existsSync(BRIDGE_SH)) console.log(`⚠️  ${BRIDGE_SH} n'existe pas encore sur ce poste : le manifeste est écrit quand même, il faudra que le pont natif soit en place pour que l'extension réponde.`);
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Sésame bridge",
    path: BRIDGE_SH,
    type: "stdio",
    allowed_origins: [`chrome-extension://${key}/`],
  };
  // Chrome lance les hôtes natifs avec un PATH minimal : on fige le chemin du node courant pour bin/sesame-bridge.sh.
  try { ensureHome(); fs.writeFileSync(path.join(HOME, "node-path"), process.execPath + "\n", { mode: 0o600 }); } catch {}
  // Le lanceur doit rester non modifiable par d'autres : Chrome exécute ce qui s'y trouve sans vérification.
  try { fs.chmodSync(BRIDGE_SH, 0o755); } catch {}
  fs.mkdirSync(target.dir, { recursive: true });
  const file = path.join(target.dir, NATIVE_HOST_NAME + ".json");
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {} // un manifeste préexistant garde sinon son ancien mode
  logEvent({ action: "install_extension", caller: "cli", result: "ok", detail: `id ${key}, ${target.name}` });
  console.log(`✅ ${target.name} : ${file} (0600)\n   Lanceur exécuté par ${target.name} : ${BRIDGE_SH}\n   Ce fichier et ce dépôt doivent rester à toi seul (chmod 755, hors dossier partagé) : ${target.name} l'exécute sans vérification.`);
  if (/^\/Users\/[^/]+\/(Downloads|Documents|Desktop)\//.test(ROOT)) {
    console.log(`\n⚠️  Ce dossier est dans ${ROOT.split("/")[3]} : macOS peut refuser à Chrome d'y exécuter le pont (« Native host has exited »).\n   Autorise Chrome pour ce dossier (Réglages Système → Confidentialité et sécurité → Fichiers et dossiers), ou déplace Sésame (ex. ~/sesame) et relance cette commande.`);
  }
  console.log(`\nRecharge l'extension dans chrome://extensions (bouton ↻), puis « Tester la connexion » dans son popup.\nVérifie avec : sesame doctor`);
}

/** Ping du pont natif sur ~/.sesame/bridge.sock (JSON une ligne, réponse une ligne). null = pas de pont, undefined = pas de réponse à temps. */
function pingBridge(timeoutMs = 3000) { // le pont attend lui-même jusqu'à 2 s le pong de l'extension
  return new Promise(resolve => {
    if (!fs.existsSync(BRIDGE_SOCKET)) return resolve(null);
    let settled = false;
    const done = v => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch {} resolve(v); };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    const sock = net.createConnection(BRIDGE_SOCKET);
    let buf = "";
    sock.on("connect", () => sock.write(JSON.stringify({ type: "ping" }) + "\n"));
    sock.on("data", d => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done(undefined); } }
    });
    sock.on("error", () => done(undefined));
  });
}

function install(target) {
  if (target === "extension") return installExtension(opt("--id"), opt("--browser") || "chrome");
  if (SNIPPET_TARGETS.includes(target)) return printSnippets(target);
  const entry = { command: nodeBin(), args: [MCP_BIN, "cowork"] };
  const results = [];

  if (target === "claude-code" || target === "all") {
    try {
      execFileSync("claude", ["mcp", "remove", "sesame", "-s", "user"], { stdio: "ignore" });
    } catch {}
    try {
      execFileSync("claude", ["mcp", "add", "-s", "user", "sesame", "--", nodeBin(), MCP_BIN, "claude-code"], { stdio: "inherit" });
      results.push("✅ Claude Code : serveur « sesame » ajouté (portée utilisateur).");
    } catch {
      results.push(`⚠️  Claude Code : la commande \`claude\` n'a pas répondu. Ajoute à la main :\n   claude mcp add -s user sesame -- "${nodeBin()}" "${MCP_BIN}" claude-code`);
    }
  }

  if (target === "cowork" || target === "desktop" || target === "all") {
    const cfgPath = path.join(os.homedir(), "Library/Application Support/Claude/claude_desktop_config.json");
    try {
      let cfg = {};
      if (fs.existsSync(cfgPath)) {
        const bak = cfgPath + `.bak-${Date.now()}`;
        fs.copyFileSync(cfgPath, bak);
        cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8") || "{}");
      } else {
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      }
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers.sesame = entry;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
      results.push(`✅ Claude Desktop / Cowork : « sesame » ajouté dans ${cfgPath}\n   (redémarre Claude Desktop pour le voir).`);
    } catch (e) {
      results.push(`⚠️  Claude Desktop : ${e.message}\n   Ajoute à la main dans claude_desktop_config.json :\n   "sesame": ${JSON.stringify(entry)}`);
    }
  }
  console.log(results.join("\n\n"));
}

async function doctor() {
  const ok = (b, msg) => console.log(`${b ? "✅" : "❌"} ${msg}`);
  ok(process.platform === "darwin", `macOS (${process.platform})`);
  ok(Number(process.versions.node.split(".")[0]) >= 20, `Node ${process.versions.node} (≥ 20 requis)`);
  ok(fs.existsSync(SITES_FILE), `Configuration : ${SITES_FILE}`);
  const sites = loadSites();
  const n = Object.keys(sites).length;
  ok(n > 0, `${n} site(s) enregistré(s)`);
  if (keychainAvailable()) {
    for (const k of Object.keys(sites)) ok(hasSecret(k), `Trousseau : secret présent pour « ${k} »`);
    if (n > 0 && !args.includes("--fast")) {
      process.stdout.write("   (lecture des droits d'accès du Trousseau, peut prendre une minute… --fast pour sauter)\n");
      const trusted = trustedAppsByAccount();
      for (const k of Object.keys(sites)) {
        if (trusted[k] === true) console.log(`⚠️  « ${k} » : l'élément du Trousseau a une application de confiance (créé avant 0.3, ou « Toujours autoriser » cliqué) → lecture silencieuse possible par tout processus. Réenregistre-le : sesame add ${k}`);
        else if (trusted[k] === false) ok(true, `Trousseau : « ${k} » sans application de confiance (chaque lecture te sera demandée)`);
      }
    }
  }
  ok(!isLocked(), isLocked() ? "Verrou global ACTIF" : "Verrou global inactif");
  ok(!!chromeBinary(), "Google Chrome installé");
  try {
    const res = await fetch(CDP_URL + "/json/version", { signal: AbortSignal.timeout(2000) });
    const v = await res.json();
    ok(true, `Chrome joignable sur ${CDP_URL} (${v.Browser})`);
  } catch {
    ok(false, `Chrome non joignable sur ${CDP_URL} → lance : sesame chrome`);
  }

  const hasManifest = nativeMessagingDirs().some(({ dir }) => fs.existsSync(path.join(dir, NATIVE_HOST_NAME + ".json")));
  ok(hasManifest, `Extension : manifeste natif ${hasManifest ? "présent" : "absent"} (sesame install extension --id <id>)`);
  const ping = await pingBridge();
  ok(!!ping, `Extension : pont natif ${ping ? "joignable" : "injoignable"} sur ${BRIDGE_SOCKET}`);
  if (ping) ok(!!ping.extension, `Extension : ${ping.extension ? "connectée" : "pont actif, extension non connectée (recharge-la dans chrome://extensions)"}`);

  console.log(`\nJournal : ${JOURNAL_FILE}`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
