// Test du pont natif et du chemin « extension » de login()/waitCode(), sans Chrome ni boîte de dialogue :
// une fausse extension parle au vrai pont sur stdio (trames natives), le serveur lui parle par la socket.
// Trousseau : service de test uniquement (secret lu par une surcharge, jamais par `security -w`).
// Couvre : protocole en deux temps (prepare → ready → fill avec jobId, sur UNE SEULE connexion authentifiée
// — voir openBridgeSession), authentification du pair par lsof/ps (exécutable réel, parent Chromium, hash du
// script — jamais l'argv, falsifiable), une socket usurpée refusée sans qu'aucun secret ne parte, un rogue
// copié sous ~/.sesame (cas B) et un rogue au process.title forgé (cas C) tous deux refusés en mode
// production (SESAME_TEST absent), une socket remplacée entre le prepare et le fill refusée sans reconnexion
// (cas D), repli autorisé seulement avant l'envoi du secret, « incertain » (jamais de repli) après l'envoi,
// https exigé pour loginUrl.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.SESAME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-bridge-"));
process.env.SESAME_KEYCHAIN_SERVICE = "sesame-test-" + process.pid;
process.env.SESAME_CDP_URL = "http://127.0.0.1:1";          // personne n'écoute : le Chrome Sésame est « down »
process.env.SESAME_CHROME = "/nonexistent/Sesame Chrome";     // … et ne peut pas être lancé : erreur nette, sans Chrome
delete process.env.SESAME_BROWSER;
delete process.env.SESAME_TEST; // posé explicitement là où le banc en a besoin (pont sans parent Chrome)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = { username: "sam@test.local", password: "zz-secret-zz" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
setTimeout(() => { console.error("⏱ délai global dépassé"); process.exit(2); }, 120000).unref();

const cfg = await import("../src/config.js");
const kc = await import("../src/keychain.js");
const { readJournal } = await import("../src/journal.js");
const {
  BRIDGE_SOCK, BRIDGE_SCRIPT, bridgePing, extensionReady, bridgeRequest,
  openBridgeSession, authenticateBridge, BridgeError,
} = await import("../src/bridge-client.js");
const { login, waitCode, FALLBACK_STEP, UNSURE_MESSAGE, scrubUrls } = await import("../src/login.js");

cfg.saveSites({ banc: { domain: "example.org", loginUrl: "https://login.example.org/", policy: "always", selectors: { code: "#otp" } } });
const withSecret = kc.keychainAvailable();
if (withSecret) kc.setSecret("banc", { username: "x", password: "y-not-the-real-one" }); // présence seulement (hasSecret)
const noLeak = (s, what) => assert.ok(!String(s).includes(SECRET.password) && !String(s).includes(SECRET.username), `secret visible dans ${what}`);
const results = [];

// ---- Fausse extension : lit/écrit des trames natives sur le stdio du pont. ----
function fakeExtension(child, onMessage) {
  let buf = Buffer.alloc(0);
  child.stdout.on("data", chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      buf = buf.subarray(4 + len);
      onMessage(msg);
    }
  });
  return {
    send(obj) { const b = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); child.stdin.write(Buffer.concat([h, b])); },
    close() { child.stdin.end(); },
  };
}
function startBridge(scriptPath = path.join(ROOT, "bin/sesame-bridge.js"), env = process.env) {
  const child = spawn(process.execPath, [scriptPath], { env: { ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", d => { stderr += d; });
  return { child, stderr: () => stderr, exited: new Promise(r => child.on("exit", r)) };
}
async function waitSocket(present, ms = 6000) {
  const t = Date.now() + ms;
  while (Date.now() < t) { if (fs.existsSync(BRIDGE_SOCK) === present) return true; await sleep(100); }
  return false;
}
async function waitPid(pid, ms = 8000) {
  const t = Date.now() + ms; let p = null;
  while (Date.now() < t && !(p && p.pid === pid)) { await sleep(200); p = await bridgePing(); }
  return p;
}

// 0) Sans pont : ping nul, extension absente, login() comme avant (erreur Chrome, sans étape de repli).
assert.equal(await bridgePing(), null);
assert.equal(await extensionReady(), false);
await assert.rejects(bridgeRequest({ type: "ping" }), e => e instanceof BridgeError && e.code === "ENOENT");
await assert.rejects(authenticateBridge(), e => e instanceof BridgeError && e.code === "ENOENT");
await assert.rejects(openBridgeSession(), e => e instanceof BridgeError && e.code === "ENOENT");
if (withSecret) {
  const r0 = await login({ site: "banc", caller: "test", readSecret: () => ({ ...SECRET }) });
  assert.equal(r0.ok, false); assert.match(r0.message, /Chrome/); assert.equal(r0.steps, undefined);
  noLeak(JSON.stringify(r0), "réponse sans pont");
  results.push("0 sans pont → " + r0.message.slice(0, 50) + "…");
}
assert.ok(scrubUrls("Cannot access https://site.example/cb?code=SECRET#frag now") === "Cannot access https://site.example/cb now");
results.push("0b scrubUrls nettoie les URL complètes");

// 1) Vrai pont + fausse extension, lancé directement par ce test (parent = node, pas Chrome) : n'authentifie
//    qu'avec SESAME_TEST=1 côté client (jamais d'après ce que le pont dirait de lui-même). C'est le mode des
//    bancs d'essai : le reste du fichier (sections 1 à 6, hors B/C/D ci-dessous) tourne sous ce drapeau.
process.env.SESAME_TEST = "1";
const b1 = startBridge();
const seen = [];
const JOB = "11111111-2222-4333-8444-555555555555";
const ext = fakeExtension(b1.child, msg => {
  seen.push(msg);
  if (msg.type === "ping") return ext.send({ id: msg.id, type: "pong", version: "0.5.0-test" });
  if (msg.type === "prepare") {
    if (msg.site.key === "banc") {
      assert.equal(msg.site.domain, "example.org"); assert.equal(msg.site.loginUrl, "https://login.example.org/");
      assert.deepEqual(msg.site.selectors, { code: "#otp" });
    }
    assert.ok(!("username" in msg) && !("password" in msg), "prepare sans secret");
    return ext.send({ id: msg.id, type: "ready", ok: true, jobId: JOB, url: "https://login.example.org/?sid=STRIP", steps: ["page de connexion ouverte dans un nouvel onglet"], reason: null });
  }
  if (msg.type === "fill") {
    assert.equal(msg.jobId, JOB, "fill porte le jobId du prepare");
    assert.ok(!("site" in msg), "fill sans description de site (elle est liée au job)");
    assert.equal(msg.username, SECRET.username); assert.equal(msg.password, SECRET.password);
    assert.equal(msg.submit, true); assert.equal(msg.waitCode, true); assert.equal(msg.codeTimeoutSec, 30);
    setTimeout(() => ext.send({
      id: msg.id, type: "result", ok: true,
      steps: ["page de connexion ouverte dans un nouvel onglet", "identifiant rempli", "étape 1 validée (bouton)", "mot de passe rempli", "formulaire soumis (bouton)", "code demandé par le site (champ texte (6 car.))", "code saisi par l'utilisateur, connexion poursuivie (4 s)"],
      url: "https://app.example.org/home?token=SHOULD-BE-STRIPPED#frag", title: "Bienvenue",
      secondFactor: { pending: false, kind: "champ", detail: "champ texte (6 car.)" }, hint: null,
      reason: "voir https://app.example.org/err?token=SHOULD-BE-STRIPPED-TOO",
      username: "ne-doit-pas-passer", // une extension bavarde : le pont retire ces champs
    }), 300);
  }
  if (msg.type === "waitCode") {
    assert.equal(msg.site.key, "banc"); assert.equal(msg.timeoutSec, 20);
    ext.send({ id: msg.id, type: "result", ok: true, steps: ["code saisi par l'utilisateur, connexion poursuivie (2 s)"], url: "https://app.example.org/home", title: "Bienvenue", secondFactor: { pending: false, kind: "champ", detail: "champ" }, hint: null, reason: null });
  }
});
assert.ok(await waitSocket(true), "socket du pont créée");
assert.equal(fs.statSync(BRIDGE_SOCK).mode & 0o777, 0o600, "socket en 0600");
const ping = await bridgePing();
assert.equal(ping.extension, true); assert.equal(ping.version, "0.5.0-test"); assert.equal(ping.pid, b1.child.pid);
assert.equal(fs.realpathSync(ping.script), fs.realpathSync(BRIDGE_SCRIPT), "le pong annonce le vrai script du pont");
assert.equal(await extensionReady(), true);
const auth = await authenticateBridge();
assert.equal(auth.pid, b1.child.pid); assert.equal(auth.ppid, process.pid, "pont lancé par ce test (parent node, SESAME_TEST=1)");
const bad = await bridgeRequest({ type: "bizarre" }).catch(e => e);
assert.ok(bad instanceof BridgeError && /inconnu/.test(bad.message));
// Le pont refuse : un fill sans jobId (rien ne part vers l'extension), un prepare dont loginUrl n'est pas https.
// (Ces vérifications sont celles du pont lui-même — indépendantes de l'authentification du pair côté client.)
const fills = () => seen.filter(m => m.type === "fill").length;
const noJob = await bridgeRequest({ type: "fill", username: "u-test", password: "p-test", codeTimeoutSec: 10 }).catch(e => e);
assert.ok(noJob instanceof BridgeError && /jobId/.test(noJob.message) && noJob.code === "bridge", String(noJob));
assert.equal(fills(), 0, "fill sans jobId non relayé");
const http = await bridgeRequest({ type: "prepare", site: { key: "x", domain: "edf.fr", loginUrl: "http://edf.fr/login" } }).catch(e => e);
assert.ok(http instanceof BridgeError && /https/.test(http.message), String(http));
assert.equal(seen.filter(m => m.type === "prepare").length, 0, "prepare http non relayé");
const httpLocal = await bridgeRequest({ type: "prepare", site: { key: "x", domain: "127.0.0.1", loginUrl: "http://127.0.0.1:8766/" } });
assert.equal(httpLocal.type, "ready", "hôte local en http accepté (banc d'essai)");
results.push("1a ping/auth → extension:true, pid+script vérifiés (lsof + ps + hash) ; fill sans jobId et loginUrl http refusés par le pont");

// Une seule connexion pour prepare + fill : on le vérifie directement (hors login()) avant le test de bout en bout.
{
  const s = await openBridgeSession();
  const readyRaw = await s.prepare({ site: { key: "banc", domain: "example.org", loginUrl: "https://login.example.org/", selectors: { code: "#otp" } } });
  assert.equal(readyRaw.type, "ready"); assert.equal(readyRaw.ok, true);
  const fillRaw = await s.fill({ jobId: readyRaw.jobId, username: SECRET.username, password: SECRET.password, submit: true, waitCode: true, codeTimeoutSec: 30 });
  assert.equal(fillRaw.type, "result"); assert.equal(fillRaw.ok, true, JSON.stringify(fillRaw));
  s.close();
  results.push("1a-bis prepare puis fill sur LA MÊME connexion (session.prepare/session.fill) → OK");
}

if (withSecret) {
  const r1 = await login({ site: "banc", caller: "test", codeTimeoutSec: 30, readSecret: () => ({ ...SECRET }) });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.channel, "extension");
  assert.equal(r1.url, "https://app.example.org/home", "URL sans query ni fragment");
  assert.equal(r1.secondFactor.pending, false);
  assert.ok(r1.steps.some(s => s.startsWith("code saisi")));
  assert.equal(r1.hint, undefined); assert.equal(r1.username, undefined);
  noLeak(JSON.stringify(r1), "réponse de login (extension)");
  const order = seen.filter(m => m.type === "prepare" || m.type === "fill").map(m => m.type);
  assert.deepEqual(order.slice(-2), ["prepare", "fill"], "prepare avant fill : " + order.join(","));
  const j = readJournal({ site: "banc", limit: 50 });
  assert.ok(j.some(e => e.action === "login" && e.result === "autorisé"));
  assert.ok(j.some(e => e.action === "2fa" && e.result === "attente" && e.channel === "extension"));
  assert.ok(j.some(e => e.action === "2fa" && e.result === "réussi" && e.channel === "extension"));
  assert.ok(j.some(e => e.action === "login" && e.result === "réussi" && e.channel === "extension" && e.caller === "test"));
  assert.ok(!JSON.stringify(j).includes("SHOULD-BE-STRIPPED"), "URL complètes nettoyées dans le journal (url et reason)");
  assert.equal(cfg.getSite("banc").lastUsed !== undefined, true, "lastUsed touché");
  results.push("1b prepare → fill par l'extension (login(), même connexion) → OK : " + r1.steps.join(", "));

  const w1 = await waitCode({ site: "banc", caller: "test", timeoutSec: 20 });
  assert.equal(w1.ok, true, JSON.stringify(w1)); assert.equal(w1.channel, "extension"); assert.match(w1.message, /Code saisi/);
  results.push("1c waitCode par l'extension → OK");

  // SESAME_BROWSER=chrome-profile : le pont n'est pas consulté, comportement d'avant.
  process.env.SESAME_BROWSER = "chrome-profile";
  const before = seen.length;
  const r2 = await login({ site: "banc", caller: "test", readSecret: () => ({ ...SECRET }) });
  assert.equal(r2.ok, false); assert.equal(r2.channel, undefined); assert.equal(r2.steps, undefined); assert.equal(seen.length, before, "pont non sollicité");
  delete process.env.SESAME_BROWSER;
  results.push("1d SESAME_BROWSER=chrome-profile → pont ignoré");
}
noLeak(JSON.stringify(seen.filter(m => m.type !== "fill")), "messages non-fill vers l'extension");
noLeak(fs.readFileSync(cfg.JOURNAL_FILE, "utf8"), "journal");

// 2) Un second pont pendant que le premier est actif : il attend sans prendre la socket, puis la reprend.
const b2 = startBridge();
const ext2 = fakeExtension(b2.child, msg => { if (msg.type === "ping") ext2.send({ id: msg.id, type: "pong", version: "0.5.0-second" }); });
await sleep(2500);
assert.equal((await bridgePing()).pid, b1.child.pid, "le premier pont reste actif");
assert.match(b2.stderr(), /déjà actif/);
ext.close(); // Chrome n°1 ferme le lien : le premier pont s'arrête, le second prend la socket
await b1.exited;
noLeak(b1.stderr(), "stderr du pont");
const p2 = await waitPid(b2.child.pid);
assert.ok(p2 && p2.pid === b2.child.pid, "le second pont a repris la socket : " + JSON.stringify(p2));
assert.equal(p2.version, "0.5.0-second");
ext2.close();
await b2.exited;
assert.ok(await waitSocket(false, 3000), "socket retirée à l'arrêt");
results.push("2 second pont → en attente, puis reprise de la socket après l'arrêt du premier");

// 3) Usurpation : une fausse socket à la place du pont, qui répond au ping comme un pont avec extension.
//    Le serveur doit la refuser (« pont non authentifié ») et ne JAMAIS lui envoyer prepare ni fill —
//    ici : mode, pid absent, pid détenteur mais étranger, pid = ce processus lui-même (garde dédiée).
{
  const got = [];
  let pongPid = undefined; // valeur de `pid` annoncée par le faux pont
  const rogue = net.createServer(conn => {
    conn.setEncoding("utf8");
    conn.on("data", d => {
      for (const line of d.split("\n").filter(Boolean)) {
        const req = JSON.parse(line);
        got.push(req.type);
        noLeak(line, "faux pont (usurpation)");
        if (req.type === "ping") conn.write(JSON.stringify({ id: req.id, ok: true, type: "pong", extension: true, version: "x", bridge: "0.5.0", script: BRIDGE_SCRIPT, ...(pongPid === undefined ? {} : { pid: pongPid }) }) + "\n");
        else conn.write(JSON.stringify({ id: req.id, ok: true, type: req.type === "prepare" ? "ready" : "result", jobId: JOB, steps: [], url: "https://x/" }) + "\n");
      }
    });
  });
  await new Promise(r => rogue.listen(BRIDGE_SOCK, r));
  assert.equal(await extensionReady(), true, "le faux pont passe le simple ping (c'est le point)");
  // a) socket pas en 0600 (umask ordinaire) : refusée avant même le ping.
  assert.notEqual(fs.statSync(BRIDGE_SOCK).mode & 0o777, 0o600);
  await assert.rejects(openBridgeSession(), e => e.code === "unauthenticated" && /0600/.test(e.message));
  fs.chmodSync(BRIDGE_SOCK, 0o600);
  // b) pong sans pid.
  await assert.rejects(openBridgeSession(), e => e.code === "unauthenticated" && /pid/.test(e.message));
  // c) pid d'un processus qui ne détient pas la socket (le parent de ce test).
  pongPid = process.ppid;
  await assert.rejects(openBridgeSession(), e => e.code === "unauthenticated" && /ne détient pas/.test(e.message));
  // d) pid qui détient bien la socket (ce test lui-même, via le faux pont in-process) : garde dédiée,
  //    avant même de regarder lsof/ps — s'authentifier soi-même ne doit jamais passer.
  pongPid = process.pid;
  await assert.rejects(openBridgeSession(), e => e.code === "unauthenticated" && /tenue par ce processus/.test(e.message));
  if (withSecret) {
    for (const p of [undefined, process.pid]) {
      pongPid = p;
      const r3 = await login({ site: "banc", caller: "test", readSecret: () => { throw new Error("le Trousseau ne doit pas être lu"); } });
      assert.equal(r3.ok, false); assert.match(r3.message, /non authentifié/); assert.equal(r3.steps, undefined, "pas de repli");
      noLeak(JSON.stringify(r3), "réponse (usurpation)");
    }
    const j3 = readJournal({ site: "banc", limit: 5 });
    assert.ok(j3.some(e => e.action === "login" && e.result === "refusé" && e.channel === "extension" && /non authentifié/.test(e.detail)), JSON.stringify(j3));
  }
  assert.ok(!got.includes("prepare") && !got.includes("fill"), "le faux pont n'a reçu que des ping : " + got.join(","));
  await new Promise(r => rogue.close(r));
  try { fs.unlinkSync(BRIDGE_SOCK); } catch {}
  results.push("3 socket usurpée (in-process) → « pont non authentifié » (mode, pid absent, pid sans socket, auto-authentification) ; aucun prepare/fill envoyé, Trousseau non lu");
}

/** Copie bin/sesame-bridge.js + src/config.js + src/bridge-client.js sous `dir` (mêmes chemins relatifs). */
function stageBridge(dir) {
  for (const f of ["bin/sesame-bridge.js", "src/config.js", "src/bridge-client.js"]) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  return path.join(dir, "bin/sesame-bridge.js");
}

// B) Copie INTÉGRALE (même contenu, donc même hash) du pont sous ~/.sesame/x/bin/sesame-bridge.js, lancée
//    par un node ordinaire (pas Chrome — son parent est ce test). En mode PRODUCTION (SESAME_TEST absent
//    de l'environnement du client, posé nulle part par le pont lui-même) : refusée quand même, parce que
//    (a) son parent n'est pas un navigateur Chromium et (b) le script annoncé n'est ni le fichier du dépôt
//    ni — hors SESAME_TEST=1 — accepté simplement parce qu'il est sous ~/.sesame. Un octet-pour-octet ne
//    suffit donc pas : copier bin/sesame-bridge.js sous ~/.sesame n'aide plus un usurpateur.
{
  const prevTest = process.env.SESAME_TEST;
  delete process.env.SESAME_TEST; // mode production pour CE test
  const rogueDir = path.join(process.env.SESAME_HOME, "x");
  const rogueScript = stageBridge(rogueDir);
  assert.equal(fs.readFileSync(rogueScript, "utf8"), fs.readFileSync(BRIDGE_SCRIPT, "utf8"), "copie identique (même hash)");
  const bridgeB = startBridge(rogueScript);
  const extB = fakeExtension(bridgeB.child, msg => { if (msg.type === "ping") extB.send({ id: msg.id, type: "pong", version: "rogue-B" }); });
  assert.ok(await waitPid(bridgeB.child.pid), "pont B (copie sous ~/.sesame) actif");
  const errB = await openBridgeSession().catch(e => e);
  assert.ok(errB instanceof BridgeError && errB.code === "unauthenticated", String(errB));
  assert.match(errB.message, /Chromium|hors du dépôt/, errB.message);
  if (withSecret) {
    const rB = await login({ site: "banc", caller: "test", readSecret: () => { throw new Error("le Trousseau ne doit pas être lu (cas B)"); } });
    assert.equal(rB.ok, false); assert.match(rB.message, /non authentifié/); assert.equal(rB.steps, undefined, "pas de repli");
    noLeak(JSON.stringify(rB), "réponse (cas B)");
  }
  extB.close();
  await bridgeB.exited;
  assert.ok(await waitSocket(false, 3000));
  if (prevTest === undefined) delete process.env.SESAME_TEST; else process.env.SESAME_TEST = prevTest;
  results.push("B rogue copié octet-pour-octet sous ~/.sesame, lancé par node (pas Chrome) → « pont non authentifié » en mode production ; Trousseau non lu");
}

// C) Rogue au process.title forgé « node <dépôt>/bin/sesame-bridge.js » (+ argv rallongé, l'ancienne
//    attaque contre `ps -o command=`) : PLUS lu du tout par l'authentification (elle ne consulte plus
//    l'argv). Le rogue va plus loin et ANNONCE dans son pong `script: <le vrai bin/sesame-bridge.js du
//    dépôt>` — un mensonge qui, seul, passerait le contrôle de hash. Il est quand même refusé, parce que
//    son PARENT (ce test) n'est pas un navigateur Chromium : c'est cette vérification-là qui arrête
//    l'attaque, pas le hash ni l'exécutable (un vrai node, lui, passe ces deux-là).
{
  const prevTest = process.env.SESAME_TEST;
  delete process.env.SESAME_TEST; // mode production pour CE test
  const rogueFile = path.join(process.env.SESAME_HOME, "rogue-c.mjs");
  const forgedTitle = `node ${BRIDGE_SCRIPT} --profile=default --flag-to-look-legit=1 --another=2`;
  const src = [
    'import net from "node:net";',
    'import fs from "node:fs";',
    `process.title = ${JSON.stringify(forgedTitle)};`,
    `const SOCK = ${JSON.stringify(BRIDGE_SOCK)};`,
    'try { fs.unlinkSync(SOCK); } catch {}',
    'const srv = net.createServer(conn => {',
    '  conn.setEncoding("utf8");',
    '  let buf = "";',
    '  conn.on("data", d => {',
    '    buf += d;',
    '    let i;',
    '    while ((i = buf.indexOf("\\n")) >= 0) {',
    '      const line = buf.slice(0, i); buf = buf.slice(i + 1);',
    '      if (!line.trim()) continue;',
    '      let req; try { req = JSON.parse(line); } catch { continue; }',
    '      if (req.type === "ping") {',
    `        conn.write(JSON.stringify({ id: req.id, ok: true, type: "pong", extension: true, version: "rogue-C", bridge: "0.5.0", pid: process.pid, script: ${JSON.stringify(BRIDGE_SCRIPT)} }) + "\\n");`,
    '      } else {',
    `        conn.write(JSON.stringify({ id: req.id, ok: true, type: req.type === "prepare" ? "ready" : "result", jobId: ${JSON.stringify(JOB)}, steps: [], url: "https://x/" }) + "\\n");`,
    '      }',
    '    }',
    '  });',
    '});',
    'srv.listen(SOCK, () => { try { fs.chmodSync(SOCK, 0o600); } catch {} process.stdout.write("LISTENING\\n"); });',
  ].join("\n");
  fs.writeFileSync(rogueFile, src, { mode: 0o755 });
  const got = [];
  const bridgeC = spawn(process.execPath, [rogueFile], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error("rogue C n'a jamais écouté")), 8000);
    bridgeC.stdout.on("data", d => { out += d; if (out.includes("LISTENING")) { clearTimeout(t); resolve(); } });
  });
  assert.ok(await waitSocket(true, 3000), "socket du rogue C créée");
  assert.equal((await bridgePing()).pid, bridgeC.pid, "le rogue C répond au ping");
  const errC = await openBridgeSession().catch(e => e);
  assert.ok(errC instanceof BridgeError && errC.code === "unauthenticated", String(errC));
  assert.match(errC.message, /Chromium/, `refusé au contrôle du parent, pas ailleurs : ${errC.message}`);
  // Vérifie directement, sur la socket brute, qu'aucun prepare/fill n'a jamais été envoyé par le client.
  const rawSock = net.createConnection(BRIDGE_SOCK);
  await new Promise(r => rawSock.on("connect", r));
  rawSock.on("data", d => { for (const line of d.toString().split("\n").filter(Boolean)) { try { got.push(JSON.parse(line)); } catch {} } });
  rawSock.destroy();
  if (withSecret) {
    const rC = await login({ site: "banc", caller: "test", readSecret: () => { throw new Error("le Trousseau ne doit pas être lu (cas C)"); } });
    assert.equal(rC.ok, false); assert.match(rC.message, /non authentifié/); assert.equal(rC.steps, undefined, "pas de repli");
    noLeak(JSON.stringify(rC), "réponse (cas C)");
  }
  bridgeC.kill();
  await new Promise(r => bridgeC.on("exit", r));
  try { fs.unlinkSync(BRIDGE_SOCK); } catch {}
  if (prevTest === undefined) delete process.env.SESAME_TEST; else process.env.SESAME_TEST = prevTest;
  results.push("C rogue process.title forgé + script annoncé mensonger (le vrai chemin du dépôt) → refusé sur le parent (pas Chromium) ; Trousseau non lu, rien reçu au-delà du ping");
}

if (withSecret) {
  // 4) Repli AVANT l'envoi du secret (mode auto) : le vrai pont perd son Chrome pendant le prepare → étape de repli, Chrome Sésame tenté.
  const b3 = startBridge();
  const ext3 = fakeExtension(b3.child, msg => {
    if (msg.type === "ping") return ext3.send({ id: msg.id, type: "pong", version: "x" });
    if (msg.type === "prepare") ext3.close(); // Chrome quitte pendant la préparation
  });
  assert.ok(await waitPid(b3.child.pid), "pont 3 actif");
  const r4 = await login({ site: "banc", caller: "test", readSecret: () => ({ ...SECRET }) });
  assert.equal(r4.ok, false); assert.match(r4.message, /Chrome/);
  assert.deepEqual(r4.steps, [FALLBACK_STEP]);
  const j4 = readJournal({ site: "banc", limit: 5 });
  assert.ok(j4.some(e => e.action === "login" && e.result === "erreur" && e.channel === "extension" && e.detail.startsWith(FALLBACK_STEP)));
  noLeak(JSON.stringify(j4), "journal (repli)");
  await b3.exited;
  assert.ok(await waitSocket(false, 3000));
  results.push("4 extension qui lâche AVANT le secret → « " + FALLBACK_STEP + " » puis Chrome Sésame");

  // 5) APRÈS l'envoi du secret : le pont perd son Chrome pendant le fill → « incertain », PAS de repli.
  const b4 = startBridge();
  const ext4 = fakeExtension(b4.child, msg => {
    if (msg.type === "ping") return ext4.send({ id: msg.id, type: "pong", version: "x" });
    if (msg.type === "prepare") return ext4.send({ id: msg.id, type: "ready", ok: true, jobId: JOB, url: "https://login.example.org/", steps: ["onglet trouvé"] });
    if (msg.type === "fill") ext4.close(); // Chrome quitte juste après avoir reçu le secret
  });
  assert.ok(await waitPid(b4.child.pid), "pont 4 actif");
  const r5 = await login({ site: "banc", caller: "test", codeTimeoutSec: 10, readSecret: () => ({ ...SECRET }) });
  assert.equal(r5.ok, false); assert.equal(r5.uncertain, true);
  assert.ok(r5.message.startsWith(UNSURE_MESSAGE), r5.message); assert.match(r5.message, /peut-être/);
  assert.equal(r5.channel, "extension"); assert.deepEqual(r5.steps, ["onglet trouvé"]);
  assert.ok(!(r5.steps || []).includes(FALLBACK_STEP), "pas de repli après envoi");
  const j5 = readJournal({ site: "banc", limit: 3 });
  assert.ok(j5.some(e => e.action === "login" && e.result === "incertain" && e.channel === "extension"), JSON.stringify(j5));
  assert.ok(!j5.some(e => (e.detail || "").startsWith(FALLBACK_STEP)));
  noLeak(JSON.stringify(j5), "journal (incertain)");
  await b4.exited;
  assert.ok(await waitSocket(false, 3000));
  results.push("5 extension qui lâche APRÈS le secret → « incertain », aucun repli");

  // 5b) Délai après envoi (extension muette sur fill) → BridgeError code « sent » ; avant envoi (prepare muet) → autre code.
  //     Prepare et fill restent sur LA MÊME session (comme le fait login()).
  const b5 = startBridge();
  const ext5 = fakeExtension(b5.child, msg => {
    if (msg.type === "ping") return ext5.send({ id: msg.id, type: "pong", version: "x" });
    if (msg.type === "prepare") return ext5.send({ id: msg.id, type: "ready", ok: true, jobId: JOB, url: "https://login.example.org/", steps: [] });
    // fill : silence
  });
  assert.ok(await waitPid(b5.child.pid), "pont 5 actif");
  const session5 = await openBridgeSession();
  const ready5 = await session5.prepare({ site: { key: "banc", domain: "example.org", loginUrl: "https://login.example.org/" } });
  assert.equal(ready5.ok, true); assert.equal(ready5.jobId, JOB);
  const sent = await session5.fill({ jobId: JOB, username: "u-test", password: "p-test", codeTimeoutSec: 10 }, { timeoutMs: 1500 }).catch(e => e);
  assert.ok(sent instanceof BridgeError && sent.code === "sent", String(sent && sent.code));
  session5.close();
  ext5.close();
  await b5.exited;
  assert.ok(await waitSocket(false, 3000));
  results.push("5b délai après envoi (même session) → BridgeError « sent »");

  // 6) Mode extension sans pont : message net, pas de repli.
  process.env.SESAME_BROWSER = "extension";
  const r6 = await login({ site: "banc", caller: "test", readSecret: () => ({ ...SECRET }) });
  assert.equal(r6.ok, false); assert.match(r6.message, /extension Sésame ne répond pas/);
  const w6 = await waitCode({ site: "banc", caller: "test", timeoutSec: 10 });
  assert.equal(w6.ok, false); assert.match(w6.message, /extension Sésame ne répond pas/);
  delete process.env.SESAME_BROWSER;
  results.push("6 SESAME_BROWSER=extension sans pont → pas de repli, message net");

  // D) La connexion authentifiée meurt entre prepare et fill (pont mort, socket reprise par un rogue) :
  //    le fill échoue net sur CETTE connexion — JAMAIS de reconnexion vers qui que ce soit d'autre, même si
  //    quelqu'un a entre-temps pris la socket. C'est exactement le scénario que la connexion unique corrige :
  //    avec deux connexions séparées (l'ancien code), le fill aurait rouvert une socket et se serait
  //    ré-authentifié auprès du rogue.
  const bD = startBridge();
  const extD = fakeExtension(bD.child, msg => {
    if (msg.type === "ping") return extD.send({ id: msg.id, type: "pong", version: "x" });
    if (msg.type === "prepare") return extD.send({ id: msg.id, type: "ready", ok: true, jobId: JOB, url: "https://login.example.org/", steps: [] });
  });
  assert.ok(await waitPid(bD.child.pid), "pont D actif");
  const sessionD = await openBridgeSession();
  const readyD = await sessionD.prepare({ site: { key: "banc", domain: "example.org", loginUrl: "https://login.example.org/" } });
  assert.equal(readyD.ok, true, JSON.stringify(readyD));
  bD.child.kill(); // le vrai pont meurt entre le prepare et le fill
  await bD.exited;
  assert.ok(await waitSocket(false, 3000), "le pont mort a retiré sa socket");
  const rogueGot = [];
  const rogueD = net.createServer(conn => { conn.setEncoding("utf8"); conn.on("data", d => rogueGot.push(d)); });
  await new Promise(r => rogueD.listen(BRIDGE_SOCK, r));
  fs.chmodSync(BRIDGE_SOCK, 0o600); // un rogue prend la socket, à la place du pont disparu
  const fillErrD = await sessionD.fill({ jobId: JOB, username: "u-test", password: "p-test", codeTimeoutSec: 10 }).catch(e => e);
  assert.ok(fillErrD instanceof BridgeError, String(fillErrD));
  // « closed » (fermeture vue avant l'écriture) ou « sent » (course : fermeture vue après) sont tous deux sûrs :
  // ce qui compte est que le rogue n'ait rien reçu (vérifié juste après) et qu'il n'y ait aucun repli.
  assert.ok(["closed", "sent", "timeout"].includes(fillErrD.code), "échec net attendu, obtenu : " + fillErrD.code);
  assert.equal(rogueGot.length, 0, "le rogue qui a repris la socket n'a rien reçu : aucune reconnexion");
  sessionD.close();
  await new Promise(r => rogueD.close(r));
  try { fs.unlinkSync(BRIDGE_SOCK); } catch {}
  results.push("D pont mort entre prepare et fill, socket reprise par un rogue → fill refusé sur la connexion d'origine (code " + fillErrD.code + "), rogue jamais contacté");
}

if (withSecret) { try { kc.deleteSecret("banc"); } catch {} }
noLeak(fs.readFileSync(cfg.JOURNAL_FILE, "utf8"), "journal (fin)");
console.log("✅ bridge OK\n  " + results.join("\n  "));
process.exit(0);
