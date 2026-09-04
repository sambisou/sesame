// Sésame — popup : état de la liaison avec le pont natif, test de connexion, ID de l'extension.
// Aucune donnée de site ni de secret ne transite par ici : le service worker ne renvoie qu'un état.
// Textes traduits via chrome.i18n (_locales/en, _locales/fr — anglais par défaut, français si Chrome est en français).
"use strict";

const $ = id => document.getElementById(id);
const msg = (key, subs) => chrome.i18n.getMessage(key, subs);

document.documentElement.lang = (chrome.i18n.getUILanguage() || "en").startsWith("fr") ? "fr" : "en";

/** Traduit le message d'erreur de Chrome en conseil concret. */
function advice(err) {
  const e = String(err || "");
  if (/not found/i.test(e)) return msg("adviceNotFound");
  if (/forbidden/i.test(e)) return msg("adviceForbidden");
  if (/exited|communicating/i.test(e)) return msg("adviceExited");
  return "";
}

function fmtSince(ts, prefix) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  const unit = s < 60 ? "Seconds" : s < 3600 ? "Minutes" : "Hours";
  const n = s < 60 ? s : s < 3600 ? Math.round(s / 60) : Math.round(s / 3600);
  return msg(`${prefix}${unit}`, [String(n)]);
}

function render(r, note) {
  if (!r) {
    $("dot").className = "dot";
    $("title").textContent = msg("swUnreachableTitle");
    $("detail").textContent = msg("swUnreachableDetail");
    return;
  }
  $("version").textContent = "v" + (r.version || "");
  $("extid").textContent = r.extensionId || chrome.runtime.id;
  if (r.connected) {
    $("dot").className = "dot ok";
    $("title").textContent = msg("bridgeConnectedTitle");
    $("detail").textContent = `${r.host} ${fmtSince(r.since, "since")}` + (r.busy ? msg("detailBusySuffix") : "")
      + (r.lastMessageAt ? msg("detailLastExchange", [fmtSince(r.lastMessageAt, "ago")]) : "");
    $("hint").textContent = note || msg("bridgeConnectedHint");
  } else {
    $("dot").className = "dot ko";
    $("title").textContent = msg("bridgeUnreachableTitle");
    $("detail").textContent = r.lastError || msg("noAttempt");
    $("hint").textContent = note || advice(r.lastError) || msg("fallbackHint");
  }
}

async function status() {
  try { return await chrome.runtime.sendMessage({ op: "status" }); } catch { return null; }
}

$("title").textContent = msg("statusTitleUnknown");
$("detail").textContent = msg("statusDetailQuerying");
$("test").textContent = msg("testButton");
$("copy").textContent = msg("copyButton");
$("copy").title = msg("copyButtonTitle");
$("idLabelPre").textContent = msg("idLabelPre");
$("idLabelPost").textContent = msg("idLabelPost");

$("test").addEventListener("click", async () => {
  const btn = $("test");
  btn.disabled = true; btn.textContent = msg("testButtonRunning");
  let r = null;
  try { r = await chrome.runtime.sendMessage({ op: "test" }); } catch {}
  btn.disabled = false; btn.textContent = msg("testButton");
  render(r, r && r.connected ? msg("testSuccess") : undefined);
});

$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(chrome.runtime.id); $("copy").textContent = msg("copyButtonCopied"); }
  catch { $("copy").textContent = msg("copyButtonFailed"); }
  setTimeout(() => { $("copy").textContent = msg("copyButton"); }, 1500);
});

$("extid").textContent = chrome.runtime.id;
// Le service worker vient peut-être d'être réveillé par ce popup : on lui laisse le temps d'une première tentative
// (un pont absent se signale par une déconnexion immédiate) avant de lire son état.
setTimeout(() => status().then(r => render(r)), 400);
