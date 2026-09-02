// Orchestration d'une connexion : politique → validation → Chrome → remplissage → journal.
import { getSite, loadSites, saveSites } from "./config.js";
import { getSecret, hasSecret } from "./keychain.js";
import { logEvent } from "./journal.js";
import { isLocked, askHuman, notify, notifyWaitingCode } from "./policy.js";
import { connect, findPage, openPage, fillLogin, detectSecondFactor, waitForSecondFactor } from "./browser.js";

/**
 * @param {object} o
 * @param {string} o.site      nom du site (clé dans sites.json)
 * @param {boolean} [o.submit] soumettre le formulaire (défaut true)
 * @param {boolean} [o.openIfMissing] ouvrir la page de connexion si aucun onglet ne correspond
 * @param {string} [o.caller]  qui demande (ex. "claude-code", "cowork")
 * @param {string} [o.reason]  motif affiché à l'utilisateur dans la demande d'autorisation
 * @param {boolean} [o.waitForCode] si le site demande un code (2e facteur), attendre que l'utilisateur le saisisse (défaut true)
 * @param {number} [o.codeTimeoutSec] délai d'attente du code (défaut 180 s)
 */
export async function login({ site: siteName, submit = true, openIfMissing = true, caller = "mcp", reason = "", waitForCode = true, codeTimeoutSec = 180 }) {
  const site = getSite(siteName);
  const base = { site: site.key, action: "login", caller, detail: reason || undefined };

  if (isLocked()) {
    logEvent({ ...base, result: "refusé", detail: "verrou global actif (sesame unlock)" });
    return { ok: false, message: "Sésame est verrouillé (sesame unlock pour rouvrir)." };
  }
  if (site.policy === "revoked") {
    logEvent({ ...base, result: "refusé", detail: "accès révoqué pour ce site" });
    return { ok: false, message: `Accès à « ${site.key} » révoqué par l'utilisateur. (sesame policy ${site.key} ask|always pour rouvrir)` };
  }
  if (!hasSecret(site.key)) {
    logEvent({ ...base, result: "erreur", detail: "aucun identifiant dans le Trousseau" });
    return { ok: false, message: `Aucun identifiant enregistré pour « ${site.key} » (sesame add ${site.key}).` };
  }

  if (site.policy === "ask") {
    const allowed = await askHuman({
      title: "Sésame — demande d'accès",
      message: `Claude (${caller}) demande à se connecter à « ${site.key} » (${site.domain}).\n\n${reason ? "Motif : " + reason + "\n\n" : ""}Autoriser le remplissage des identifiants dans Chrome ?`,
    });
    if (!allowed) {
      logEvent({ ...base, result: "refusé", detail: "refus ou absence de réponse de l'utilisateur" });
      return { ok: false, message: "L'utilisateur a refusé (ou n'a pas répondu) à la demande d'accès." };
    }
    logEvent({ ...base, result: "autorisé", detail: "validé par l'utilisateur (dialogue)" });
  } else {
    logEvent({ ...base, result: "autorisé", detail: "politique always" });
  }

  let browser;
  try {
    browser = await connect();
    let page = await findPage(browser, site);
    let opened = false;
    if (!page) {
      if (!openIfMissing) {
        logEvent({ ...base, result: "échec", detail: "aucun onglet correspondant" });
        return { ok: false, message: `Aucun onglet Chrome ouvert sur ${site.domain}.` };
      }
      page = await openPage(browser, site.loginUrl || `https://${site.domain}/`);
      opened = true;
    }

    const secret = getSecret(site.key);
    const res = await fillLogin(page, site, secret, {
      submitForm: submit,
      waitSecondFactor: waitForCode,
      secondFactorTimeoutSec: codeTimeoutSec,
      onSecondFactor: sf => {
        logEvent({ ...base, action: "2fa", result: "attente", detail: `code demandé par le site (${sf.detail}) — l'utilisateur doit le saisir` });
        notifyWaitingCode(site.key, { detail: sf.kind === "champ" ? "" : sf.detail, timeoutSec: codeTimeoutSec });
      },
    });
    // Effacer les références aux secrets dès que possible.
    secret.password = ""; secret.username = "";

    if (res.secondFactor) {
      logEvent({ ...base, action: "2fa", result: res.secondFactor.pending ? "en attente" : "réussi",
        detail: res.secondFactor.pending ? "code non saisi (délai dépassé ou attente désactivée)" : "code saisi par l'utilisateur, le site l'a accepté" });
    }
    if (!res.ok) {
      logEvent({ ...base, result: "échec", detail: res.reason });
      return { ok: false, message: res.reason, steps: res.steps, url: res.url, secondFactor: res.secondFactor, opened };
    }
    logEvent({ ...base, result: "réussi", detail: `${res.steps.join(", ")} → ${res.url}` });
    notify("Sésame", `Connexion à ${site.key} remplie pour Claude (${caller}).`);
    touchLastUsed(site.key);
    return { ok: true, message: res.secondFactor?.pending ? `Identifiants remplis sur « ${site.key} », le site attend un code de l'utilisateur.` : `Identifiants remplis sur « ${site.key} ».`, steps: res.steps, url: res.url, title: res.title, secondFactor: res.secondFactor, hint: res.hint, opened };
  } catch (e) {
    const msg = sanitize(e.message);
    logEvent({ ...base, result: "erreur", detail: msg });
    return { ok: false, message: msg };
  } finally {
    // connectOverCDP : fermer la connexion sans fermer Chrome.
    await browser?.close().catch(() => {});
  }
}

export async function openLogin({ site: siteName, caller = "mcp" }) {
  const site = getSite(siteName);
  const url = site.loginUrl || `https://${site.domain}/`;
  let browser;
  try {
    browser = await connect();
    const existing = await findPage(browser, site);
    const page = existing || await openPage(browser, url);
    if (existing) await page.bringToFront().catch(() => {});
    logEvent({ site: site.key, action: "open_login", caller, result: "ok", detail: page.url() });
    return { ok: true, url: page.url(), reused: !!existing };
  } catch (e) {
    const msg = sanitize(e.message);
    logEvent({ site: site.key, action: "open_login", caller, result: "erreur", detail: msg });
    return { ok: false, message: msg };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * Reprend l'attente du code (2e facteur) sur l'onglet du site, sans rien remplir.
 * Utile quand sesame_login a rendu la main avant que l'utilisateur ait saisi le code.
 */
export async function waitCode({ site: siteName, timeoutSec = 180, caller = "mcp" }) {
  const site = getSite(siteName);
  const base = { site: site.key, action: "2fa", caller };
  let browser;
  try {
    browser = await connect();
    const page = await findPage(browser, site);
    if (!page) {
      logEvent({ ...base, result: "échec", detail: "aucun onglet du site" });
      return { ok: false, message: `Aucun onglet Chrome ouvert sur ${site.domain}.` };
    }
    await page.bringToFront().catch(() => {});
    const sf = await detectSecondFactor(page, site);
    if (!sf) {
      logEvent({ ...base, result: "ok", detail: "aucun code demandé sur cet onglet" });
      return { ok: true, message: "Aucun code demandé sur cet onglet (la connexion est peut-être déjà passée).", url: page.url(), title: await page.title().catch(() => "") };
    }
    logEvent({ ...base, result: "attente", detail: `reprise de l'attente (${sf.detail})` });
    notifyWaitingCode(site.key, { detail: sf.kind === "champ" ? "" : sf.detail, timeoutSec });
    const w = await waitForSecondFactor(page, site, { timeoutSec });
    if (!w.done) {
      logEvent({ ...base, result: "en attente", detail: `code non saisi après ${timeoutSec} s` });
      return { ok: false, message: `L'utilisateur n'a pas saisi le code dans le délai (${timeoutSec} s). Rappelle sesame_wait_code quand il est prêt.`, secondFactor: { pending: true, ...sf } };
    }
    logEvent({ ...base, result: "réussi", detail: `code saisi par l'utilisateur (${w.elapsedSec} s) → ${page.url()}` });
    touchLastUsed(site.key);
    return { ok: true, message: `Code saisi par l'utilisateur, connexion poursuivie sur « ${site.key} ».`, url: page.url(), title: await page.title().catch(() => ""), secondFactor: { pending: false, ...sf } };
  } catch (e) {
    const msg = sanitize(e.message);
    logEvent({ ...base, result: "erreur", detail: msg });
    return { ok: false, message: msg };
  } finally {
    await browser?.close().catch(() => {});
  }
}

function touchLastUsed(key) {
  try {
    const sites = loadSites();
    if (sites[key]) { sites[key].lastUsed = new Date().toISOString(); saveSites(sites); }
  } catch {}
}

/** Garde-fou : ne jamais laisser une valeur de mot de passe fuiter dans un message d'erreur. */
function sanitize(msg) {
  return String(msg || "erreur inconnue").split("\n")[0].slice(0, 300);
}
