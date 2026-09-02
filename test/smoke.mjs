// Test de fumée : config, journal, verrou, et handshake MCP (sans Chrome ni Trousseau).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.SESAME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-test-"));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const cfg = await import("../src/config.js");
const journal = await import("../src/journal.js");
const policy = await import("../src/policy.js");

cfg.saveSites({ edf: { domain: "edf.fr", loginUrl: "https://particulier.edf.fr/fr/accueil/connexion.html", policy: "ask" } });
assert.equal(cfg.getSite("EDF").domain, "edf.fr");
assert.ok(cfg.siteMatchesUrl(cfg.getSite("edf"), "https://espace-client.edf.fr/x"));
assert.ok(!cfg.siteMatchesUrl(cfg.getSite("edf"), "https://notedf.fr/"));
assert.throws(() => cfg.getSite("inconnu"));
policy.lock(); assert.ok(policy.isLocked()); policy.unlock(); assert.ok(!policy.isLocked());
journal.logEvent({ site: "edf", action: "test", result: "ok" });
assert.equal(journal.readJournal({ site: "edf" }).length, 1);

// Verrou → login refusé sans Chrome ni Trousseau.
const { login } = await import("../src/login.js");
policy.lock();
const r = await login({ site: "edf", caller: "test" });
assert.equal(r.ok, false); assert.match(r.message, /verrouillé/);
policy.unlock();

// Handshake MCP via le client officiel.
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "bin/sesame-mcp.js"), "test"], env: { ...process.env } });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map(t => t.name).sort();
assert.deepEqual(tools, ["sesame_journal", "sesame_list_sites", "sesame_login", "sesame_open_login", "sesame_wait_code"]);
const sites = JSON.parse((await client.callTool({ name: "sesame_list_sites", arguments: {} })).content[0].text);
assert.equal(sites.sites[0].site, "edf");
const j = JSON.parse((await client.callTool({ name: "sesame_journal", arguments: { limit: 5 } })).content[0].text);
assert.ok(j.some(e => e.action === "server_start"));
await client.close();
console.log("✅ smoke OK —", tools.join(", "));
