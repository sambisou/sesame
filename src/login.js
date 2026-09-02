// Orchestration d'une connexion : politique → validation → Chrome → remplissage → journal.
import { getSite, loadSites, saveSites, normalizeName, siteDomainFor, assertLoginUrl } from "./config.js";
import { getSecret, hasSecret, setSecret, keychainAvailable } from "./keychain.js";
import { logEvent } from "./journal.js";
import { isLocked, askHuman, askText, notify, notifyWaitingCode } from "./policy.js";
import { connect, findPage, openPage, fillLogin, detectSecondFactor, waitForSecondFactor, publicUrl } from "./browser.js";

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
    const certain = !res.hint && !res.secondFactor?.pending;
    logEvent({ ...base, result: certain ? "réussi" : "incertain", detail: `${res.steps.join(", ")}${res.hint ? " — " + res.hint : ""} → ${res.url}` });
    notify("Sésame", certain ? `Connexion à ${site.key} remplie pour Claude (${caller}).` : `Connexion à ${site.key} : à vérifier (${res.hint || "code attendu"}).`);
    if (certain) touchLastUsed(site.key);
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
    logEvent({ site: site.key, action: "open_login", caller, result: "ok", detail: publicUrl(page.url()) });
    return { ok: true, url: publicUrl(page.url()), reused: !!existing };
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
    const deadline = Date.now() + timeoutSec * 1000;
    let sf = await detectSecondFactor(page, site);
    // La page parle d'un code sans champ (choix de méthode, validation sur téléphone) : on laisse à l'utilisateur
    // le temps de faire apparaître le champ, sans le compter comme « code accepté ».
    while (sf && sf.kind === "texte-seul" && Date.now() < deadline) {
      await page.waitForTimeout(1000);
      if (page.isClosed()) break;
      sf = await detectSecondFactor(page, site);
    }
    if (!sf) {
      const stillPassword = !page.isClosed() && /password/i.test(await page.content().catch(() => "")) ? "" : "";
      logEvent({ ...base, result: "ok", detail: "aucun code demandé sur cet onglet" });
      return { ok: true, message: `Aucun code demandé sur cet onglet (la connexion est peut-être déjà passée).${stillPassword}`, url: publicUrl(page.url()), title: await page.title().catch(() => "") };
    }
    if (sf.kind === "texte-seul") {
      logEvent({ ...base, result: "en attente", detail: `page évoquant un code sans champ (${sf.detail}) après ${timeoutSec} s` });
      return { ok: false, message: `La page évoque un 2e facteur sans champ de saisie (${sf.detail}) : l'utilisateur doit d'abord choisir la méthode ou valider sur son téléphone. Rappelle sesame_wait_code ensuite.`, secondFactor: { pending: true, ...sf } };
    }
    logEvent({ ...base, result: "attente", detail: `reprise de l'attente (${sf.detail})` });
    notifyWaitingCode(site.key, { detail: sf.detail, timeoutSec });
    const w = await waitForSecondFactor(page, site, { timeoutSec: Math.max(10, Math.round((deadline - Date.now()) / 1000)) });
    if (!w.done) {
      const pending = w.reason === "délai dépassé";
      logEvent({ ...base, result: pending ? "en attente" : "échec", detail: pending ? `code non saisi après ${timeoutSec} s` : w.reason });
      return { ok: false, message: pending ? `L'utilisateur n'a pas saisi le code dans le délai (${timeoutSec} s). Rappelle sesame_wait_code quand il est prêt.` : `Attente du code interrompue : ${w.reason}.`, secondFactor: { pending, ...sf } };
    }
    logEvent({ ...base, result: "réussi", detail: `code saisi par l'utilisateur (${w.elapsedSec} s) → ${publicUrl(page.url())}` });
    touchLastUsed(site.key);
    return { ok: true, message: `Code saisi par l'utilisateur, connexion poursuivie sur « ${site.key} ».`, url: publicUrl(page.url()), title: await page.title().catch(() => ""), secondFactor: { pending: false, ...sf } };
  } catch (e) {
    const msg = sanitize(e.message);
    logEvent({ ...base, result: "erreur", detail: msg });
    return { ok: false, message: msg };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * Un site n'est pas encore dans Sésame : ouvre des fenêtres Sésame sur le Mac pour que l'utilisateur
 * saisisse lui-même identifiant et mot de passe. Les valeurs vont au Trousseau, jamais à l'IA.
 * Remplace le « lance `sesame add …` dans un terminal ».
 *
 * @param {object} o
 * @param {string} o.site     nom court (ex. "infomaniak")
 * @param {string} o.url      URL de la page de connexion
 * @param {string} [o.reason] pourquoi Claude en a besoin (affiché)
 * @param {string} [o.note]   mémo (ex. « connexion en 2 étapes »)
 * @param {string} [o.caller]
 * @param {object} [o.ui]     surcharge des dialogues pour les tests : { confirm, text }
 */
export async function requestSite({ site: siteName, url, reason = "", note, caller = "mcp", replace = false, ui } = {}) {
  const key = normalizeName(siteName || "");
  const base = { site: key || undefined, action: "request_site", caller };
  if (!key) return { ok: false, message: "Nom de site manquant (ex. « infomaniak »)." };
  try { assertLoginUrl(url); } catch (e) { return { ok: false, message: e.message }; }
  const domain = siteDomainFor(url);
  if (!domain) return { ok: false, message: `URL de connexion invalide : ${url || "(vide)"}.` };
  if (isLocked()) {
    logEvent({ ...base, result: "refusé", detail: "verrou global actif" });
    return { ok: false, message: "Sésame est verrouillé (sesame unlock pour rouvrir)." };
  }
  if (!keychainAvailable()) return { ok: false, message: "Trousseau macOS indisponible : Sésame ne fonctionne que sur Mac." };

  const sites = loadSites();
  const existing = sites[key];
  if (existing && hasSecret(key) && !replace) {
    logEvent({ ...base, result: "ok", detail: "déjà enregistré" });
    return { ok: true, alreadyRegistered: true, site: key, domain: existing.domain, policy: existing.policy, message: `« ${key} » est déjà enregistré : appelle sesame_login.` };
  }

  const confirm = ui?.confirm || (o => askHuman({ okLabel: "Enregistrer", cancelLabel: "Plus tard", defaultOk: true, timeoutSec: 300, ...o }));
  const text = ui?.text || askText;

  const intro = `Claude (${caller}) a besoin de se connecter à « ${key} » (${domain}).\n\n${reason ? "Motif : " + reason + "\n\n" : ""}Sésame va vous demander votre identifiant puis votre mot de passe pour ce site. Ils seront rangés dans le Trousseau macOS ; Claude ne les verra jamais.\n\nEnregistrer ce site maintenant ?`;
  const go = await confirm({ title: "Sésame — nouveau site", message: intro });
  if (!go) {
    logEvent({ ...base, result: "refusé", detail: "l'utilisateur a refusé ou n'a pas répondu" });
    return { ok: false, refused: true, message: "L'utilisateur n'a pas souhaité enregistrer ce site maintenant." };
  }

  const username = await text({ title: `Sésame — ${key} (1/3)`, message: `Identifiant ou e-mail pour ${domain} (laissez vide si le site n'en demande pas) :` });
  if (username === null) { logEvent({ ...base, result: "refusé", detail: "annulé à l'identifiant" }); return { ok: false, refused: true, message: "Saisie annulée par l'utilisateur." }; }

  let password = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const p1 = await text({ title: `Sésame — ${key} (2/3)`, message: `Mot de passe pour ${domain} (la frappe est masquée) :`, hidden: true });
    if (p1 === null) { logEvent({ ...base, result: "refusé", detail: "annulé au mot de passe" }); return { ok: false, refused: true, message: "Saisie annulée par l'utilisateur." }; }
    if (!p1) continue;
    const p2 = await text({ title: `Sésame — ${key} (3/3)`, message: "Confirmez le mot de passe :", hidden: true, okLabel: "Enregistrer" });
    if (p2 === null) { logEvent({ ...base, result: "refusé", detail: "annulé à la confirmation" }); return { ok: false, refused: true, message: "Saisie annulée par l'utilisateur." }; }
    if (p1 === p2) { password = p1; break; }
    await confirm({ title: "Sésame", message: "Les deux saisies diffèrent. On recommence ?" });
  }
  if (!password) { logEvent({ ...base, result: "échec", detail: "mot de passe vide ou non confirmé" }); return { ok: false, message: "Mot de passe non confirmé après trois essais." }; }

  try {
    setSecret(key, { username: username.trim(), password });
  } catch (e) {
    logEvent({ ...base, result: "échec", detail: `écriture Trousseau : ${sanitize(e.message)}` });
    return { ok: false, message: "Impossible d'écrire dans le Trousseau macOS (trousseau verrouillé ? demande refusée ?). Réessaie après l'avoir déverrouillé." };
  } finally {
    password = null;
  }
  sites[key] = {
    domain, loginUrl: url, policy: existing?.policy || "ask",
    note: note || existing?.note, selectors: existing?.selectors || {},
    createdAt: existing?.createdAt || new Date().toISOString(), lastUsed: existing?.lastUsed,
  };
  saveSites(sites);
  logEvent({ ...base, result: "ok", detail: `${domain}, politique ${sites[key].policy}, saisi par l'utilisateur dans la fenêtre Sésame` });
  notify("Sésame", `« ${key} » enregistré. Claude peut maintenant demander la connexion (avec votre accord à chaque fois).`);
  return { ok: true, site: key, domain, policy: sites[key].policy, message: `« ${key} » enregistré par l'utilisateur. Appelle maintenant sesame_login(site: "${key}").` };
}

function touchLastUsed(key) {
  try {
    const sites = loadSites();
    if (sites[key]) { sites[key].lastUsed = new Date().toISOString(); saveSites(sites); }
  } catch {}
}

/** Garde-fou : ne jamais laisser une valeur de mot de passe ni une ligne de commande fuiter dans un message. */
function sanitize(msg) {
  let m = String(msg || "erreur inconnue").split("\n")[0];
  if (/\bsecurity\b.*\s-w\b|"password"\s*:|Command failed/i.test(m)) m = "opération Trousseau échouée (détail masqué)";
  return m.slice(0, 300);
}
