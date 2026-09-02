#!/usr/bin/env node
// CLI Sésame — l'interface de l'utilisateur. Les secrets sont saisis ici, au clavier, jamais via Claude.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  HOME, SITES_FILE, JOURNAL_FILE, CHROME_PROFILE, CDP_URL, POLICIES,
  loadSites, saveSites, normalizeName, siteDomainFor, ensureHome,
} from "../src/config.js";
import { setSecret, deleteSecret, hasSecret, keychainAvailable } from "../src/keychain.js";
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
  serve [--port <n>]      Sert Sésame en HTTP local (Streamable HTTP, jeton obligatoire) pour les clients
                          qui ne lancent pas de processus : ChatGPT via tunnel, agents distants, etc.
  token [--rotate]        Affiche (ou renouvelle) le jeton du serveur HTTP.
  doctor                  Vérifie l'installation (Trousseau, Chrome, sites, verrou).
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

function install(target) {
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
  if (keychainAvailable()) for (const k of Object.keys(sites)) ok(hasSecret(k), `Trousseau : secret présent pour « ${k} »`);
  ok(!isLocked(), isLocked() ? "Verrou global ACTIF" : "Verrou global inactif");
  ok(!!chromeBinary(), "Google Chrome installé");
  try {
    const res = await fetch(CDP_URL + "/json/version", { signal: AbortSignal.timeout(2000) });
    const v = await res.json();
    ok(true, `Chrome joignable sur ${CDP_URL} (${v.Browser})`);
  } catch {
    ok(false, `Chrome non joignable sur ${CDP_URL} → lance : sesame chrome`);
  }
  console.log(`\nJournal : ${JOURNAL_FILE}`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
