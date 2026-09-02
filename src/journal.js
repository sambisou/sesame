// Journal d'accès append-only : ~/.sesame/journal.jsonl
// Chaque ligne = un événement. Jamais de secret dedans.
import fs from "node:fs";
import { JOURNAL_FILE, ensureHome } from "./config.js";

export function logEvent(event) {
  ensureHome();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  fs.appendFileSync(JOURNAL_FILE, line + "\n", { mode: 0o600 });
}

export function readJournal({ site, limit = 50 } = {}) {
  if (!fs.existsSync(JOURNAL_FILE)) return [];
  const lines = fs.readFileSync(JOURNAL_FILE, "utf8").split("\n").filter(Boolean);
  let events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (site) events = events.filter(e => e.site === site);
  return events.slice(-limit);
}

export function formatEvent(e) {
  const when = e.ts.replace("T", " ").slice(0, 19);
  const parts = [when, (e.site || "-").padEnd(14), e.action.padEnd(18), e.result];
  if (e.caller) parts.push(`via ${e.caller}`);
  if (e.detail) parts.push(`— ${e.detail}`);
  return parts.join("  ");
}
