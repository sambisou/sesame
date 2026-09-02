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

// Nouveau site par fenêtres Sésame (dialogues simulés, Trousseau de test).
process.env.SESAME_KEYCHAIN_SERVICE = "sesame-test-" + process.pid;
const kc = await import("../src/keychain.js");
const { requestSite } = await import("../src/login.js");
if (kc.keychainAvailable()) {
  const asked = [];
  const ui = {
    confirm: async o => { asked.push(o.title); return true; },
    text: async o => { asked.push(o.title); return o.hidden ? "s3cret-test" : "sam@test.local"; },
  };
  const r1 = await requestSite({ site: "Banc Test", url: "https://login.example.org/x", reason: "test", caller: "test", ui });
  assert.equal(r1.ok, true, JSON.stringify(r1)); assert.equal(r1.site, "banc-test"); assert.equal(r1.domain, "login.example.org"); assert.equal(r1.policy, "ask");
  assert.ok(!JSON.stringify(r1).includes("s3cret"), "aucun secret dans la réponse");
  assert.ok(kc.hasSecret("banc-test")); assert.equal(cfg.getSite("banc-test").loginUrl, "https://login.example.org/x");
  assert.deepEqual(asked, ["Sésame — nouveau site", "Sésame — banc-test (1/3)", "Sésame — banc-test (2/3)", "Sésame — banc-test (3/3)"]);
  const r2 = await requestSite({ site: "banc-test", url: "https://login.example.org/x", caller: "test", ui });
  assert.equal(r2.alreadyRegistered, true);
  const r3 = await requestSite({ site: "autre", url: "https://a.example.org/", caller: "test", ui: { confirm: async () => false, text: ui.text } });
  assert.equal(r3.ok, false); assert.equal(r3.refused, true); assert.ok(!kc.hasSecret("autre"));
  kc.deleteSecret("banc-test");
  assert.ok(journal.readJournal({ site: "banc-test" }).some(e => e.action === "request_site" && e.result === "ok"));
}

// Handshake MCP via le client officiel.
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "bin/sesame-mcp.js"), "test"], env: { ...process.env } });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map(t => t.name).sort();
assert.deepEqual(tools, ["sesame_journal", "sesame_list_sites", "sesame_login", "sesame_open_login", "sesame_request_site", "sesame_wait_code"]);
const sites = JSON.parse((await client.callTool({ name: "sesame_list_sites", arguments: {} })).content[0].text);
assert.equal(sites.sites[0].site, "edf");
const j = JSON.parse((await client.callTool({ name: "sesame_journal", arguments: { limit: 5 } })).content[0].text);
assert.ok(j.some(e => e.action === "server_start"));
await client.close();
console.log("✅ smoke OK —", tools.join(", "));
