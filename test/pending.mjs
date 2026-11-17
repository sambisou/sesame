// Demande d'accord plus longue que le délai d'appel du client MCP : askSiteAccess rend `pending`, la même
// question reste ouverte, le rappel la rejoint (jamais une seconde fenêtre), un accord tardif est gardé.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.SESAME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-test-"));
process.env.SESAME_KEYCHAIN_SERVICE = "sesame-test-" + process.pid;
process.env.SESAME_PENDING_SEC = "1";
const { askSiteAccess, askWaiting, PENDING_ACCESS_MESSAGE } = await import("../src/login.js");
assert.match(PENDING_ACCESS_MESSAGE, /affichée sur le Mac/);

const asks = path.join(process.env.SESAME_HOME, "asks");
const beat = () => fs.writeFileSync(path.join(process.env.SESAME_HOME, "bar.alive"), "test\n");
beat(); const beating = setInterval(beat, 1000);
const files = () => (fs.existsSync(asks) ? fs.readdirSync(asks).filter(n => n.endsWith(".json") && !n.endsWith(".done.json")) : []);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = { kind: "access", site: "edf", title: "T", message: "M", timeoutSec: 30 };

if (process.platform === "darwin") {
  // 1) Pas de réponse avant le délai : `pending`, une seule question déposée.
  const a = await askSiteAccess("edf", q);
  assert.equal(a.pending, true);
  assert.equal(files().length, 1);
  assert.equal(askWaiting("edf"), true, "le rappel saura qu'une fenêtre attend (pas de sonde avant de la rejoindre)");
  assert.equal(askWaiting("autre"), false);
  // 2) Rappel : rejoint la même question, aucune seconde fenêtre.
  const second = askSiteAccess("edf", q);
  await sleep(200);
  assert.equal(files().length, 1, "pas de seconde question");
  // 3) Sam répond pendant le rappel : le rappel reçoit l'accord.
  const f = files()[0];
  fs.writeFileSync(path.join(asks, f.replace(/\.json$/, ".done.json")), JSON.stringify({ allowed: true, always: false }));
  const b = await second;
  assert.equal(b.allowed, true);
  // 4) Accord arrivé APRÈS le retour `pending` : gardé pour le rappel suivant, sans nouvelle question.
  const c = await askSiteAccess("edf", q);
  assert.equal(c.pending, true);
  const g = files()[0];
  fs.writeFileSync(path.join(asks, g.replace(/\.json$/, ".done.json")), JSON.stringify({ allowed: true, always: false }));
  await sleep(800);
  const d = await askSiteAccess("edf", q);
  assert.equal(d.allowed, true);
  assert.equal(files().length, 0, "l'accord gardé évite une nouvelle fenêtre");
  assert.equal(askWaiting("edf"), false, "plus rien n'attend une fois la réponse rendue");
  // 5) L'accord gardé n'est valable qu'une fois.
  const e = await askSiteAccess("edf", { ...q, timeoutSec: 30 });
  assert.equal(e.pending, true);
  fs.writeFileSync(path.join(asks, files()[0].replace(/\.json$/, ".done.json")), JSON.stringify({ allowed: false }));
  await sleep(800);
  const h = await askSiteAccess("edf", q);
  assert.equal(h.allowed, false, "un refus tardif est rendu tel quel");
}
clearInterval(beating);
console.log("pending.mjs : ok");
process.exit(0);
