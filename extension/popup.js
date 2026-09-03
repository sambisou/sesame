// Sésame — popup : état de la liaison avec le pont natif, test de connexion, ID de l'extension.
// Aucune donnée de site ni de secret ne transite par ici : le service worker ne renvoie qu'un état.
"use strict";

const $ = id => document.getElementById(id);

/** Traduit le message d'erreur de Chrome en conseil concret. */
function advice(err) {
  const e = String(err || "");
  if (/not found/i.test(e)) return "Manifeste natif absent : dans un terminal, lance `sesame install extension --id <ID ci-dessous>`, puis recharge l'extension.";
  if (/forbidden/i.test(e)) return "L'ID de cette extension n'est pas autorisé par le manifeste natif : relance `sesame install extension --id <ID ci-dessous>`, puis recharge l'extension.";
  if (/exited|communicating/i.test(e)) return "Le pont s'est arrêté (Node introuvable ? un autre pont actif ?). Vérifie avec `sesame doctor`.";
  return "";
}

function fmtSince(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `depuis ${s} s`;
  if (s < 3600) return `depuis ${Math.round(s / 60)} min`;
  return `depuis ${Math.round(s / 3600)} h`;
}

function render(r, note) {
  if (!r) {
    $("dot").className = "dot";
    $("title").textContent = "Service worker injoignable";
    $("detail").textContent = "Recharge l'extension depuis chrome://extensions.";
    return;
  }
  $("version").textContent = "v" + (r.version || "");
  $("extid").textContent = r.extensionId || chrome.runtime.id;
  if (r.connected) {
    $("dot").className = "dot ok";
    $("title").textContent = "Pont natif connecté";
    $("detail").textContent = `${r.host} ${fmtSince(r.since)}` + (r.busy ? " — remplissage en cours" : "") + (r.lastMessageAt ? ` · dernier échange ${fmtSince(r.lastMessageAt).replace("depuis", "il y a")}` : "");
    $("hint").textContent = note || "Le serveur Sésame (sesame_login) passera par cette extension pour remplir les formulaires dans ce Chrome.";
  } else {
    $("dot").className = "dot ko";
    $("title").textContent = "Pont natif injoignable";
    $("detail").textContent = r.lastError || "Aucune tentative aboutie pour l'instant.";
    $("hint").textContent = note || advice(r.lastError) || "Sans pont, Sésame se replie sur son Chrome à profil dédié.";
  }
}

async function status() {
  try { return await chrome.runtime.sendMessage({ op: "status" }); } catch { return null; }
}

$("test").addEventListener("click", async () => {
  const btn = $("test");
  btn.disabled = true; btn.textContent = "Test en cours…";
  let r = null;
  try { r = await chrome.runtime.sendMessage({ op: "test" }); } catch {}
  btn.disabled = false; btn.textContent = "Tester la connexion";
  render(r, r && r.connected ? "Test réussi : Chrome a lancé le pont et il répond." : undefined);
});

$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(chrome.runtime.id); $("copy").textContent = "Copié"; } catch { $("copy").textContent = "Échec"; }
  setTimeout(() => { $("copy").textContent = "Copier l'ID"; }, 1500);
});

$("extid").textContent = chrome.runtime.id;
// Le service worker vient peut-être d'être réveillé par ce popup : on lui laisse le temps d'une première tentative
// (un pont absent se signale par une déconnexion immédiate) avant de lire son état.
setTimeout(() => status().then(render), 400);
