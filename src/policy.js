// Politique d'accès par site + verrou global + validation humaine (boîte de dialogue macOS).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { HOME, LOCK_FILE, POLICIES, ensureHome } from "./config.js";
import { t } from "./i18n.js";

export function isLocked() { return fs.existsSync(LOCK_FILE); }
export function lock() { ensureHome(); fs.writeFileSync(LOCK_FILE, new Date().toISOString() + "\n"); }
export function unlock() { if (isLocked()) fs.unlinkSync(LOCK_FILE); }

export function assertPolicy(p) {
  if (!POLICIES.includes(p)) throw new Error(`Politique invalide « ${p} » (attendu : ${POLICIES.join(" | ")})`);
}

/** L'app Sésame (barre des menus) écrit ~/.sesame/bar.alive toutes les 2 s tant qu'elle tourne. */
export function barAlive() {
  try {
    const st = fs.statSync(path.join(HOME, "bar.alive"));
    return Date.now() - st.mtimeMs < 10000;
  } catch { return false; }
}

/** Dossier des questions posées à l'utilisateur via l'app Sésame (~/.sesame/asks). */
function asksDir() {
  const dir = path.join(HOME, "asks");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Pose la question dans l'app Sésame : dépose ~/.sesame/asks/<id>.json, l'app ouvre une fenêtre flottante
 * (au-dessus de tout, sur tous les bureaux, sans voler le clavier) et répond dans <id>.done.json. On attend
 * cette réponse jusqu'à `timeoutSec` ; passé ce délai, ou si l'app disparaît, la demande est retirée.
 * Renvoie { allowed, always } — `always` : l'utilisateur a coché « ne plus me demander pour ce site ».
 * Renvoie null (et non un refus) si l'app a disparu avant de répondre : l'appelant peut alors se rabattre
 * sur la boîte de dialogue système.
 */
async function askViaBar(o) {
  const dir = asksDir();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(dir, id + ".json");
  const done = path.join(dir, id + ".done.json");
  const payload = {
    id, kind: o.kind || "generic", site: o.site, domain: o.domain, caller: o.caller, reason: o.reason, channel: o.channel,
    title: o.title, message: o.message, okLabel: o.okLabel, cancelLabel: o.cancelLabel, offerAlways: !!o.offerAlways,
    timeoutSec: o.timeoutSec, ts: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  const deadline = Date.now() + o.timeoutSec * 1000;
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(done)) {
        let ans = {};
        try { ans = JSON.parse(fs.readFileSync(done, "utf8")); } catch {}
        return { allowed: ans.allowed === true, always: ans.allowed === true && ans.always === true };
      }
      if (!barAlive()) return null; // l'app est partie : la fenêtre n'existe plus, personne ne répondra
      await sleep(250);
    }
    return { allowed: false, always: false, timedOut: true };
  } finally {
    try { fs.unlinkSync(file); } catch {}
    try { fs.unlinkSync(done); } catch {}
  }
}

/**
 * Demande d'autorisation à l'utilisateur. Quand l'app Sésame tourne, c'est elle qui pose la question
 * (fenêtre flottante retrouvable dans le menu Sésame) ; sinon, boîte de dialogue macOS. Renvoie
 * { allowed, always }. Champs structurés facultatifs (site, domain, caller, reason, channel, kind,
 * offerAlways) : ils servent à l'app pour une fenêtre lisible ; title/message restent le texte de secours.
 */
export async function askAccess(o) {
  const full = { timeoutSec: 90, okLabel: t("ok_authorize"), cancelLabel: t("cancel_refuse"), defaultOk: false, ...o };
  if (process.platform !== "darwin") return { allowed: false, always: false };
  if (barAlive()) {
    const started = Date.now();
    const r = await askViaBar(full);
    if (r) return r;
    const left = Math.max(10, full.timeoutSec - Math.round((Date.now() - started) / 1000));
    return { allowed: await askDialog({ ...full, timeoutSec: left }), always: false };
  }
  return { allowed: await askDialog(full), always: false };
}

/**
 * Affiche une boîte de dialogue et attend la réponse de l'utilisateur (via l'app Sésame si elle tourne,
 * sinon boîte de dialogue macOS). Renvoie true si « Autoriser », false sinon (Refuser, fermeture, délai).
 */
export async function askHuman(o) {
  return (await askAccess(o)).allowed;
}

/** Boîte de dialogue macOS (osascript) : le secours quand l'app Sésame ne tourne pas. */
function askDialog({ title, message, timeoutSec = 90, okLabel = t("ok_authorize"), cancelLabel = t("cancel_refuse"), defaultOk = false }) {
  if (process.platform !== "darwin") return Promise.resolve(false);
  const esc = s => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script =
    `display dialog "${esc(message)}" with title "${esc(title)}" ` +
    `buttons {"${esc(cancelLabel)}", "${esc(okLabel)}"} default button "${esc(defaultOk ? okLabel : cancelLabel)}" cancel button "${esc(cancelLabel)}" ` +
    `with icon caution giving up after ${timeoutSec}`;
  return new Promise(resolve => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: (timeoutSec + 5) * 1000 }, (err, stdout) => {
      if (err) return resolve(false); // bouton d'annulation → osascript renvoie une erreur "User canceled"
      const out = String(stdout);
      resolve(new RegExp(`button returned:${okLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(out) && !/gave up:true/.test(out));
    });
  });
}

/**
 * Boîte de dialogue macOS avec un champ de saisie. `hidden` masque la frappe (mot de passe).
 * Renvoie la chaîne saisie, ou null si l'utilisateur annule / ne répond pas.
 * La valeur ne quitte jamais ce processus : elle sert au Trousseau, jamais à l'IA.
 */
export function askText({ title, message, hidden = false, defaultAnswer = "", okLabel = t("ok_continue"), timeoutSec = 180 }) {
  if (process.platform !== "darwin") return Promise.resolve(null);
  const cancelLabel = t("cancel_cancel");
  const esc = s => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script =
    `display dialog "${esc(message)}" with title "${esc(title)}" default answer "${esc(defaultAnswer)}" ` +
    `${hidden ? "with hidden answer " : ""}buttons {"${esc(cancelLabel)}", "${esc(okLabel)}"} default button "${esc(okLabel)}" cancel button "${esc(cancelLabel)}" ` +
    `with icon note giving up after ${timeoutSec}`;
  return new Promise(resolve => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: (timeoutSec + 5) * 1000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = String(stdout);
      if (/gave up:true/.test(out)) return resolve(null);
      const m = out.match(/text returned:([\s\S]*?)(?:, gave up:(?:true|false))?\s*$/);
      resolve(m ? m[1] : null);
    });
  });
}

/** Où l'utilisateur doit regarder, selon le canal : son Chrome habituel (extension) ou le Chrome Sésame (profil dédié). */
export function channelLabel(channel) {
  return channel === "extension" ? t("channel_extension") : t("channel_chrome_profile");
}

/**
 * Prévient l'utilisateur qu'un site demande un code (2e facteur) et que Sésame attend.
 * Non bloquant : l'utilisateur tape le code dans le Chrome nommé (selon le canal), la détection se fait dans la page.
 */
export function notifyWaitingCode(siteKey, { detail = "", timeoutSec = 180, channel = "chrome-profile" } = {}) {
  const min = Math.max(1, Math.round(timeoutSec / 60));
  notify(
    t("notif_code_title"),
    t("notif_code_message", { site: siteKey, detail: detail ? ` (${detail})` : "", channel: channelLabel(channel), min })
  );
}

/** Notification discrète (pas bloquante). */
export function notify(title, message) {
  if (process.platform !== "darwin") return;
  const esc = s => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile("/usr/bin/osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`], () => {});
}
