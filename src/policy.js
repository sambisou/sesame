// Politique d'accès par site + verrou global + validation humaine (boîte de dialogue macOS).
import fs from "node:fs";
import { execFile } from "node:child_process";
import { LOCK_FILE, POLICIES, ensureHome } from "./config.js";
import { t } from "./i18n.js";

export function isLocked() { return fs.existsSync(LOCK_FILE); }
export function lock() { ensureHome(); fs.writeFileSync(LOCK_FILE, new Date().toISOString() + "\n"); }
export function unlock() { if (isLocked()) fs.unlinkSync(LOCK_FILE); }

export function assertPolicy(p) {
  if (!POLICIES.includes(p)) throw new Error(`Politique invalide « ${p} » (attendu : ${POLICIES.join(" | ")})`);
}

/**
 * Affiche une boîte de dialogue macOS et attend la réponse de l'utilisateur.
 * Renvoie true si « Autoriser », false sinon (Refuser, fermeture, ou délai dépassé).
 */
export function askHuman({ title, message, timeoutSec = 90, okLabel = t("ok_authorize"), cancelLabel = t("cancel_refuse"), defaultOk = false }) {
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
