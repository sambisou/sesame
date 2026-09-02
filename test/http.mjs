// Test du transport HTTP (Streamable HTTP) avec le client MCP officiel : jeton, liste d'outils, appel d'outil.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.SESAME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-http-"));
const cfg = await import("../src/config.js");
cfg.saveSites({ edf: { domain: "edf.fr", loginUrl: "https://particulier.edf.fr/", policy: "ask" } });

const { serveHttp } = await import("../src/http.js");
const srv = await serveHttp({ port: 0 });
assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

// Sans jeton → 401, et rien d'autre.
const r401 = await fetch(srv.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
assert.equal(r401.status, 401);

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

// Avec jeton en en-tête (Cursor, VS Code, Codex, Gemini, agents…).
const c1 = new Client({ name: "http-test", version: "0" });
await c1.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { Authorization: `Bearer ${srv.token}`, "X-Sesame-Caller": "test-http" } } }));
const tools = (await c1.listTools()).tools.map(t => t.name).sort();
assert.deepEqual(tools, ["sesame_journal", "sesame_list_sites", "sesame_login", "sesame_open_login", "sesame_wait_code"]);
const sites = JSON.parse((await c1.callTool({ name: "sesame_list_sites", arguments: {} })).content[0].text);
assert.equal(sites.sites[0].site, "edf");
await c1.close();

// Avec jeton dans l'URL (clients sans en-tête personnalisé, ex. connecteur ChatGPT derrière un tunnel).
const c2 = new Client({ name: "http-test-url", version: "0" });
await c2.connect(new StreamableHTTPClientTransport(new URL(srv.urlWithToken)));
const j = JSON.parse((await c2.callTool({ name: "sesame_journal", arguments: { limit: 5 } })).content[0].text);
assert.ok(j.some(e => e.action === "http_start"));
await c2.close();

// Le journal a bien noté le refus et l'appelant.
const { readJournal } = await import("../src/journal.js");
const ev = readJournal({ limit: 50 });
assert.ok(ev.some(e => e.action === "http_refuse"));

await srv.close();
console.log("✅ http OK —", tools.join(", "), "— jeton en en-tête et dans l'URL, 401 sans jeton");
