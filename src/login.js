// Orchestration d'une connexion : politique → validation → Chrome → remplissage → journal.
import fs from "node:fs";
import path from "node:path";
import { HOME, getSite, loadSites, saveSites, normalizeName, siteDomainFor, assertLoginUrl } from "./config.js";
import { getSecret, hasSecret, setSecret, keychainAvailable } from "./keychain.js";
import { logEvent } from "./journal.js";
import { isLocked, askHuman, askText, notify, notifyWaitingCode, channelLabel } from "./policy.js";
import { connect, findPage, openPage, fillLogin, detectSecondFactor, waitForSecondFactor, publicUrl, hasLoginFields, gotoLogin } from "./browser.js";
import { browserMode, extensionReady, openBridgeSession, bridgeWaitCode } from "./bridge-client.js";

/** Étape ajoutée en tête de `steps` quand l'extension a lâché AVANT tout envoi de secret (mode auto). */
export const FALLBACK_STEP = "extension injoignable, repli sur le Chrome Sésame";
/** Réponse quand le secret est parti vers l'extension sans réponse : jamais de repli (le formulaire a peut-être été soumis). */
export const UNSURE_MESSAGE = "L'extension Sésame n'a pas répondu : le formulaire a peut-être été rempli et soumis. Vérifie l'onglet dans ton Chrome habituel. Aucun repli sur le Chrome Sésame (les identifiants ne seront pas saisis deux fois).";

/**
 * @param {object} o
 * @param {string} o.site      nom du site (clé dans sites.json)
 * @param {boolean} [o.submit] soumettre le formulaire (défaut true)
 * @param {boolean} [o.openIfMissing] ouvrir la page de connexion si aucun onglet ne correspond
 * @param {string} [o.caller]  qui demande (ex. "claude-code", "cowork")
 * @param {string} [o.reason]  motif affiché à l'utilisateur dans la demande d'autorisation
 * @param {boolean} [o.waitForCode] si le site demande un code (2e facteur), attendre que l'utilisateur le saisisse (défaut true)
 * @param {number} [o.codeTimeoutSec] délai d'attente du code (défaut 180 s)
 * @param {(key:string) => {username:string,password:string}} [o.readSecret] lecture du secret (Trousseau par défaut ; surcharge pour les bancs d'essai)
 *
 * Canal (SESAME_BROWSER = auto | extension | chrome-profile, défaut auto) : si le pont natif répond et que
 * l'extension Chrome est connectée, le remplissage se fait dans le Chrome habituel de l'utilisateur, en deux
 * temps (prepare : onglet et formulaire trouvés ; puis lecture du Trousseau ; puis fill) ; sinon dans le Chrome
 * Sésame à profil dédié. En mode auto, le repli sur le Chrome Sésame n'a lieu que si l'extension a lâché AVANT
 * tout envoi de secret ; après l'envoi (« sent »), la réponse dit « incertain » et rien n'est rejoué. Un pont
 * non authentifié (un autre processus tient la socket) est refusé, sans repli.
 */
export async function login({ site: siteName, submit = true, openIfMissing = true, caller = "mcp", reason = "", waitForCode = true, codeTimeoutSec = 180, readSecret = getSecret }) {
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

  // Canal : l'extension dans le Chrome habituel si elle répond (mode auto/extension), sinon le Chrome Sésame.
  // Décidé avant le dialogue, pour que celui-ci nomme le Chrome où les identifiants seront tapés.
  const mode = browserMode();
  const viaExtension = mode !== "chrome-profile" && await extensionReady();
  if (!viaExtension && mode === "extension") {
    logEvent({ ...base, result: "erreur", detail: "extension Chrome injoignable (SESAME_BROWSER=extension, pas de repli)" });
    return { ok: false, message: "L'extension Sésame ne répond pas : ouvre Chrome avec l'extension Sésame activée, ou passe SESAME_BROWSER=auto pour autoriser le Chrome Sésame." };
  }
  let channel = viaExtension ? "extension" : "chrome-profile";

  if (site.policy === "ask") {
    const allowed = await askHuman({
      title: "Sésame — demande d'accès",
      message: `Claude (${caller}) demande à se connecter à « ${site.key} » (${site.domain}).\n\n${reason ? "Motif : " + reason + "\n\n" : ""}Autoriser le remplissage des identifiants dans ${channelLabel(channel)} ?`,
    });
    if (!allowed) {
      logEvent({ ...base, result: "refusé", detail: "refus ou absence de réponse de l'utilisateur" });
      return { ok: false, message: "L'utilisateur a refusé (ou n'a pas répondu) à la demande d'accès." };
    }
    logEvent({ ...base, result: "autorisé", detail: `validé par l'utilisateur (dialogue, ${channel})` });
  } else {
    logEvent({ ...base, result: "autorisé", detail: `politique always (${channel})` });
  }

  let browser;
  let secret = null;
  const steps = [];
  try {
    let res = null;
    if (viaExtension) {
      // 1er temps : l'extension trouve l'onglet et le formulaire. Aucun secret n'a encore été lu.
      const prep = await prepareViaExtension(site);
      let fail = null; // { cause, code } d'un échec de canal, avant ou après l'envoi du secret
      if (prep.ready && !prep.ready.ok) {
        logEvent({ ...base, channel, result: "échec", detail: prep.ready.reason });
        return { ok: false, message: prep.ready.reason, steps: prep.ready.steps, url: prep.ready.url, channel };
      }
      if (prep.ready) {
        // 2e temps : le Trousseau n'est lu que maintenant, un formulaire du bon domaine ayant été vu.
        // Sur la MÊME connexion authentifiée que le prepare (voir openBridgeSession) : remplacer la
        // socket entre les deux temps ne change rien, et si ce pont meurt entre-temps, l'envoi échoue net.
        secret = readSecret(site.key);
        const r = await fillViaExtension(prep.session, prep.ready.jobId, secret, { submit, waitForCode, codeTimeoutSec });
        if (r.result) {
          res = r.result;
          if (prep.ready.steps.length && !res.steps.some(s => prep.ready.steps.includes(s))) res.steps = [...prep.ready.steps, ...res.steps];
        } else if (r.code === "sent") {
          // Le secret est parti et la réponse n'est pas venue : le formulaire a peut-être été soumis. Jamais de repli.
          logEvent({ ...base, channel, result: "incertain", detail: `secret transmis à l'extension sans réponse : ${r.cause} (pas de repli)` });
          notify("Sésame", `Connexion à ${site.key} : l'extension n'a pas répondu, vérifie l'onglet.`);
          return { ok: false, uncertain: true, message: `${UNSURE_MESSAGE} (${r.cause})`, steps: prep.ready.steps, url: prep.ready.url, channel };
        } else {
          fail = r;
        }
      } else {
        fail = prep;
      }
      if (fail) {
        if (fail.code === "unauthenticated") {
          logEvent({ ...base, channel, result: "refusé", detail: `${fail.cause} (rien n'a été envoyé, pas de repli)` });
          return { ok: false, message: `Pont Sésame non authentifié : ${fail.cause}. Un autre processus occupe peut-être ~/.sesame/bridge.sock. Rien n'a été envoyé ; aucun repli. Relance Chrome (ou ferme ce processus), puis vérifie avec sesame doctor.` };
        }
        if (mode === "extension") {
          logEvent({ ...base, channel, result: "erreur", detail: `extension Chrome : ${fail.cause} (SESAME_BROWSER=extension, pas de repli)` });
          return { ok: false, message: `L'extension Sésame n'a pas répondu (${fail.cause}). Rien n'a été envoyé : le formulaire n'a pas été rempli.` };
        }
        // Mode auto, et rien n'a été envoyé : on se replie sur le Chrome à profil dédié, et on le dit.
        logEvent({ ...base, channel, result: "erreur", detail: `${FALLBACK_STEP} (${fail.cause})` });
        steps.push(FALLBACK_STEP);
        channel = "chrome-profile";
      }
    }

    if (!res) {
      browser = await connect();
      let page = await findPage(browser, site);
      let opened = false;
      if (!page) {
        if (!openIfMissing) {
          logEvent({ ...base, result: "échec", detail: "aucun onglet correspondant" });
          return { ok: false, message: `Aucun onglet Chrome ouvert sur ${site.domain}.`, steps: steps.length ? steps : undefined };
        }
        page = await openPage(browser, site.loginUrl || `https://${site.domain}/`);
        opened = true;
      } else if (!(await hasLoginFields(page, site))) {
        // Onglet du site sans formulaire (déjà connecté, tableau de bord, déconnexion) : on ouvre la page de
        // connexion dans un autre onglet, sans toucher à celui de l'utilisateur.
        page = await openPage(browser, site.loginUrl || `https://${site.domain}/`);
        if (!(await hasLoginFields(page, site))) await gotoLogin(page, site.loginUrl || `https://${site.domain}/`, site);
        opened = true;
      }

      secret = secret || readSecret(site.key);
      res = await fillLogin(page, site, secret, {
        submitForm: submit,
        waitSecondFactor: waitForCode,
        secondFactorTimeoutSec: codeTimeoutSec,
        onSecondFactor: sf => {
          logEvent({ ...base, action: "2fa", result: "attente", detail: `code demandé par le site (${sf.detail}) — l'utilisateur doit le saisir` });
          notifyWaitingCode(site.key, { detail: sf.kind === "champ" ? "" : sf.detail, timeoutSec: codeTimeoutSec, channel: "chrome-profile" });
        },
      });
      res.opened = opened;
    } else {
      // Par l'extension, le « code demandé » n'est connu qu'au retour : on le journalise alors, et on ne
      // prévient l'utilisateur que si le code reste à saisir (sinon il l'a déjà tapé).
      const asked = (res.steps || []).find(st => /^code demandé/.test(st));
      if (asked) {
        logEvent({ ...base, channel, action: "2fa", result: "attente", detail: `${asked} — l'utilisateur doit le saisir (extension Chrome)` });
        if (res.secondFactor?.pending) notifyWaitingCode(site.key, { detail: res.secondFactor.detail || "", timeoutSec: codeTimeoutSec, channel: "extension" });
      }
    }
    // Effacer les références aux secrets dès que possible.
    secret.password = ""; secret.username = "";
    secret = null;
    if (steps.length) res.steps = [...steps, ...(res.steps || [])];
    const ev = channel === "extension" ? { ...base, channel } : base;

    if (res.secondFactor) {
      logEvent({ ...ev, action: "2fa", result: res.secondFactor.pending ? "en attente" : "réussi",
        detail: res.secondFactor.pending ? "code non saisi (délai dépassé ou attente désactivée)" : "code saisi par l'utilisateur, le site l'a accepté" });
    }
    if (!res.ok) {
      logEvent({ ...ev, result: "échec", detail: res.reason });
      return { ok: false, message: res.reason, steps: res.steps, url: res.url, secondFactor: res.secondFactor, opened: res.opened, channel: channel === "extension" ? channel : undefined };
    }
    const certain = !res.hint && !res.secondFactor?.pending;
    logEvent({ ...ev, result: certain ? "réussi" : "incertain", detail: `${res.steps.join(", ")}${res.hint ? " — " + res.hint : ""} → ${res.url}` });
    notify("Sésame", certain ? `Connexion à ${site.key} remplie pour Claude (${caller}).` : `Connexion à ${site.key} : à vérifier (${res.hint || "code attendu"}).`);
    if (certain) touchLastUsed(site.key);
    return { ok: true, message: res.secondFactor?.pending ? `Identifiants remplis sur « ${site.key} », le site attend un code de l'utilisateur.` : `Identifiants remplis sur « ${site.key} ».`, steps: res.steps, url: res.url, title: res.title, secondFactor: res.secondFactor, hint: res.hint, opened: res.opened, channel: channel === "extension" ? channel : undefined };
  } catch (e) {
    const msg = sanitize(e.message);
    logEvent({ ...base, result: "erreur", detail: msg });
    return { ok: false, message: msg, steps: steps.length ? steps : undefined };
  } finally {
    if (secret) { secret.password = ""; secret.username = ""; }
    // connectOverCDP : fermer la connexion sans fermer Chrome.
    await browser?.close().catch(() => {});
  }
}

/** Description du site telle que l'extension la reçoit : rien de plus que le nécessaire au remplissage. */
function siteForExtension(site) {
  const sel = Object.fromEntries(Object.entries(site.selectors || {}).filter(([, v]) => typeof v === "string" && v));
  const s = { key: site.key, domain: site.domain, loginUrl: site.loginUrl || `https://${site.domain}/`, selectors: sel };
  if (Array.isArray(site.extraDomains) && site.extraDomains.length) s.extraDomains = site.extraDomains;
  return s;
}

/** Toute URL dans un texte libre (motif, indice, étape, message d'erreur de Chrome) est réduite à origine + chemin : jamais un code OAuth ni un jeton de lien magique. */
export function scrubUrls(s) {
  return String(s).replace(/https?:\/\/[^\s"')<>]+/g, u => publicUrl(u));
}
const str = (v, n = 300) => (typeof v === "string" ? scrubUrls(v.split("\n")[0]).slice(0, n) : undefined);

/** Met la réponse « result » de l'extension dans la forme de fillLogin ; ne laisse passer aucun champ inattendu. */
function normalizeResult(r) {
  const o = r && typeof r === "object" ? r : {};
  const steps = (Array.isArray(o.steps) ? o.steps : []).slice(0, 40).map(s => str(s, 200)).filter(Boolean);
  let secondFactor;
  if (o.secondFactor && typeof o.secondFactor === "object") {
    secondFactor = { pending: !!o.secondFactor.pending, kind: o.secondFactor.kind === "texte-seul" ? "texte-seul" : "champ", detail: str(o.secondFactor.detail, 120) || "" };
  }
  return {
    ok: !!o.ok, steps,
    url: publicUrl(str(o.url, 500) || ""),
    title: str(o.title, 200) || "",
    secondFactor,
    hint: str(o.hint) || undefined,
    reason: str(o.reason) || (o.ok ? undefined : "l'extension a signalé un échec sans motif"),
  };
}

/** Met la réponse « ready » (1er temps) dans une forme sûre : { ok, jobId, url, steps, reason }. */
function normalizeReady(r) {
  const o = r && typeof r === "object" ? r : {};
  const jobId = typeof o.jobId === "string" && /^[A-Za-z0-9-]{8,80}$/.test(o.jobId) ? o.jobId : null;
  return {
    ok: !!o.ok && !!jobId, jobId,
    url: publicUrl(str(o.url, 500) || ""),
    steps: (Array.isArray(o.steps) ? o.steps : []).slice(0, 40).map(s => str(s, 200)).filter(Boolean),
    reason: str(o.reason) || (o.ok && !jobId ? "l'extension n'a pas fourni de jobId" : o.ok ? undefined : "l'extension n'a pas pu préparer l'onglet (motif absent)"),
  };
}

/**
 * 1er temps par l'extension Chrome : ouvre UNE connexion authentifiée au pont (pair vérifié — voir
 * openBridgeSession) puis l'extension trouve ou ouvre l'onglet du site et vérifie qu'un formulaire est
 * visible. Renvoie { ready, session } (la connexion reste ouverte, pour le fill qui suit sur cette même
 * socket) ou { cause, code } si le canal a lâché ou si le pair n'est pas le pont Sésame (code
 * "unauthenticated") — la session est alors déjà refermée. Aucun secret ne circule ici.
 */
async function prepareViaExtension(site) {
  let session;
  try {
    session = await openBridgeSession();
  } catch (e) {
    return { cause: sanitize(e.message), code: e.code || "bridge" };
  }
  try {
    const r = await session.prepare({ site: siteForExtension(site) });
    const ready = normalizeReady(r);
    if (!ready.ok) session.close(); // rien à remplir : pas de fill à venir sur cette connexion
    return { ready, session: ready.ok ? session : undefined };
  } catch (e) {
    session.close();
    return { cause: sanitize(e.message), code: e.code || "bridge" };
  }
}

/**
 * 2e temps, sur la MÊME connexion authentifiée que le prepare : le secret, vers le job préparé. Renvoie
 * { result } (réponse de l'extension, normalisée), ou { cause, code } si le canal a lâché : code "sent" =
 * le secret est parti sans réponse (pas de repli possible), tout autre code = rien n'a été envoyé (par
 * exemple si le pont est mort entre le prepare et le fill : la connexion se referme net, sans jamais se
 * reconnecter vers un autre pair). Referme la session dans tous les cas.
 */
async function fillViaExtension(session, jobId, secret, { submit, waitForCode, codeTimeoutSec }) {
  const payload = {
    jobId, username: secret.username, password: secret.password,
    submit: !!submit, waitCode: !!waitForCode, codeTimeoutSec,
  };
  try {
    const r = await session.fill(payload, { timeoutMs: (codeTimeoutSec + 60) * 1000 });
    return { result: normalizeResult(r) };
  } catch (e) {
    return { cause: sanitize(e.message), code: e.code || "bridge" };
  } finally {
    payload.username = ""; payload.password = "";
    session.close();
  }
}

export async function openLogin({ site: siteName, caller = "mcp" }) {
  const site = getSite(siteName);
  if (isLocked()) {
    logEvent({ site: site.key, action: "open_login", caller, result: "refusé", detail: "verrou global actif" });
    return { ok: false, message: "Sésame est verrouillé (sesame unlock, ou l'interrupteur Verrou de l'app)." };
  }
  if (site.policy === "revoked") {
    logEvent({ site: site.key, action: "open_login", caller, result: "refusé", detail: "accès révoqué pour ce site" });
    return { ok: false, message: `Accès à « ${site.key} » coupé par l'utilisateur.` };
  }
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
  if (isLocked()) {
    logEvent({ site: site.key, action: "2fa", caller, result: "refusé", detail: "verrou global actif" });
    return { ok: false, message: "Sésame est verrouillé (sesame unlock, ou l'interrupteur Verrou de l'app)." };
  }
  if (site.policy === "revoked") {
    logEvent({ site: site.key, action: "2fa", caller, result: "refusé", detail: "accès révoqué pour ce site" });
    return { ok: false, message: `Accès à « ${site.key} » coupé par l'utilisateur.` };
  }
  const base = { site: site.key, action: "2fa", caller };

  // Par l'extension Chrome si elle répond (voir login) ; sinon, ou si elle lâche en mode auto, le Chrome Sésame.
  const mode = browserMode();
  const viaExtension = mode !== "chrome-profile" && await extensionReady();
  if (!viaExtension && mode === "extension") {
    logEvent({ ...base, result: "erreur", detail: "extension Chrome injoignable (SESAME_BROWSER=extension, pas de repli)" });
    return { ok: false, message: "L'extension Sésame ne répond pas : ouvre Chrome avec l'extension Sésame activée, ou passe SESAME_BROWSER=auto." };
  }
  const steps = [];
  if (viaExtension) {
    const ev = { ...base, channel: "extension" };
    logEvent({ ...ev, result: "attente", detail: `reprise de l'attente dans le Chrome habituel (extension, ${timeoutSec} s)` });
    let r;
    try {
      r = normalizeResult(await bridgeWaitCode({ site: siteForExtension(site), timeoutSec }, { timeoutMs: (timeoutSec + 60) * 1000 }));
    } catch (e) {
      const cause = sanitize(e.message);
      if (mode === "extension") {
        logEvent({ ...ev, result: "erreur", detail: `extension Chrome : ${cause} (SESAME_BROWSER=extension, pas de repli)` });
        return { ok: false, message: `L'extension Sésame n'a pas répondu (${cause}).` };
      }
      logEvent({ ...ev, result: "erreur", detail: `${FALLBACK_STEP} (${cause})` });
      steps.push(FALLBACK_STEP);
    }
    if (r) {
      if (r.ok && r.secondFactor && !r.secondFactor.pending) {
        logEvent({ ...ev, result: "réussi", detail: `code saisi par l'utilisateur → ${r.url}` });
        touchLastUsed(site.key);
        return { ok: true, message: `Code saisi par l'utilisateur, connexion poursuivie sur « ${site.key} ».`, url: r.url, title: r.title, secondFactor: r.secondFactor, steps: r.steps, channel: "extension" };
      }
      if (r.ok) {
        logEvent({ ...ev, result: "ok", detail: "aucun code demandé sur cet onglet" });
        return { ok: true, message: "Aucun code demandé sur cet onglet (la connexion est peut-être déjà passée).", url: r.url, title: r.title, steps: r.steps, hint: r.hint, channel: "extension" };
      }
      const pending = !!r.secondFactor?.pending;
      logEvent({ ...ev, result: pending ? "en attente" : "échec", detail: r.reason });
      return { ok: false, message: pending ? `${r.reason} Rappelle sesame_wait_code quand l'utilisateur est prêt.` : `Attente du code interrompue : ${r.reason}.`, url: r.url, secondFactor: r.secondFactor, steps: r.steps, hint: r.hint, channel: "extension" };
    }
  }

  let browser;
  try {
    browser = await connect();
    const page = await findPage(browser, site);
    if (!page) {
      logEvent({ ...base, result: "échec", detail: "aucun onglet du site" });
      return { ok: false, message: `Aucun onglet Chrome ouvert sur ${site.domain}.`, steps: steps.length ? steps : undefined };
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
    notifyWaitingCode(site.key, { detail: sf.detail, timeoutSec, channel: "chrome-profile" });
    const w = await waitForSecondFactor(page, site, { timeoutSec: Math.max(10, Math.round((deadline - Date.now()) / 1000)) });
    if (!w.done) {
      const pending = w.reason === "délai dépassé";
      logEvent({ ...base, result: pending ? "en attente" : "échec", detail: pending ? `code non saisi après ${timeoutSec} s` : w.reason });
      return { ok: false, message: pending ? `L'utilisateur n'a pas saisi le code dans le délai (${timeoutSec} s). Rappelle sesame_wait_code quand il est prêt.` : `Attente du code interrompue : ${w.reason}.`, secondFactor: { pending, ...sf } };
    }
    logEvent({ ...base, result: "réussi", detail: `code saisi par l'utilisateur (${w.elapsedSec} s) → ${publicUrl(page.url())}` });
    touchLastUsed(site.key);
    return { ok: true, message: `Code saisi par l'utilisateur, connexion poursuivie sur « ${site.key} ».`, url: publicUrl(page.url()), title: await page.title().catch(() => ""), secondFactor: { pending: false, ...sf }, steps: steps.length ? steps : undefined };
  } catch (e) {
    const msg = sanitize(e.message);
    logEvent({ ...base, result: "erreur", detail: msg });
    return { ok: false, message: msg, steps: steps.length ? steps : undefined };
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

  // Si l'app Sésame (barre des menus) tourne, c'est elle qui montre le formulaire : identifiant et mot de passe
  // sur une seule fenêtre, œil pour afficher le mot de passe. Sinon, boîtes de dialogue macOS successives.
  if (!ui && barAlive()) {
    const r = await requestViaBar({ key, url, reason, note, caller, domain, existing, sites, base });
    if (r) return r;
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
  // En cas de réenregistrement, on garde le domaine déjà réglé (parfois élargi à la main, ex. edf.fr).
  sites[key] = {
    domain: existing?.domain || domain, loginUrl: existing?.loginUrl || url, policy: existing?.policy || "ask",
    note: note || existing?.note, selectors: existing?.selectors || {},
    createdAt: existing?.createdAt || new Date().toISOString(), lastUsed: existing?.lastUsed,
  };
  saveSites(sites);
  logEvent({ ...base, result: "ok", detail: `${domain}, politique ${sites[key].policy}, saisi par l'utilisateur dans la fenêtre Sésame` });
  notify("Sésame", `« ${key} » enregistré. Claude peut maintenant demander la connexion (avec votre accord à chaque fois).`);
  return { ok: true, site: key, domain, policy: sites[key].policy, message: `« ${key} » enregistré par l'utilisateur. Appelle maintenant sesame_login(site: "${key}").` };
}

/** L'app Sésame écrit ~/.sesame/bar.alive toutes les 2 s tant qu'elle tourne. */
function barAlive() {
  try {
    const st = fs.statSync(path.join(HOME, "bar.alive"));
    return Date.now() - st.mtimeMs < 10000;
  } catch { return false; }
}

/**
 * Dépose une demande pour l'app Sésame (~/.sesame/requests/<id>.json) et attend sa réponse
 * (<id>.done.json : saved | refused). L'app enregistre elle-même le secret dans le Trousseau.
 * Renvoie null si l'app ne répond pas (on retombe alors sur les boîtes de dialogue).
 */
async function requestViaBar({ key, url, reason, note, caller, domain, base, timeoutSec = 300 }) {
  const dir = path.join(HOME, "requests");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${Date.now()}-${key}`;
  const file = path.join(dir, id + ".json");
  const done = path.join(dir, id + ".done.json");
  fs.writeFileSync(file, JSON.stringify({ id, site: key, url, reason, note, caller, ts: new Date().toISOString() }), { mode: 0o600 });
  logEvent({ ...base, result: "attente", detail: "formulaire ouvert dans l'app Sésame" });
  const deadline = Date.now() + timeoutSec * 1000;
  let status = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 700));
    if (fs.existsSync(done)) {
      try { status = JSON.parse(fs.readFileSync(done, "utf8")).status; } catch { status = "refused"; }
      break;
    }
    if (Date.now() - deadline + timeoutSec * 1000 > 8000 && !barAlive()) break; // l'app a disparu : repli
  }
  try { fs.unlinkSync(file); } catch {}
  try { fs.unlinkSync(done); } catch {}
  if (status === "saved") {
    // L'app a écrit le Trousseau et sites.json ; on relit pour répondre juste.
    const site = loadSites()[key];
    if (site && hasSecret(key)) {
      logEvent({ ...base, result: "ok", detail: `${site.domain}, politique ${site.policy}, saisi par l'utilisateur dans l'app Sésame` });
      return { ok: true, site: key, domain: site.domain, policy: site.policy, message: `« ${key} » enregistré par l'utilisateur. Appelle maintenant sesame_login(site: "${key}").` };
    }
    logEvent({ ...base, result: "échec", detail: "l'app a répondu « saved » mais le site ou le secret manque" });
    return { ok: false, message: "L'enregistrement n'a pas abouti (secret absent). Réessaie." };
  }
  if (status === "refused") {
    logEvent({ ...base, result: "refusé", detail: "« Plus tard » dans l'app Sésame" });
    return { ok: false, refused: true, message: "L'utilisateur n'a pas souhaité enregistrer ce site maintenant." };
  }
  if (status === null && Date.now() >= deadline) {
    logEvent({ ...base, result: "refusé", detail: `sans réponse dans l'app Sésame après ${timeoutSec} s` });
    return { ok: false, refused: true, message: `L'utilisateur n'a pas répondu dans le délai (${timeoutSec} s).` };
  }
  return null; // l'app a disparu : boîtes de dialogue
}

function touchLastUsed(key) {
  try {
    const sites = loadSites();
    if (sites[key]) { sites[key].lastUsed = new Date().toISOString(); saveSites(sites); }
  } catch {}
}

/** Garde-fou : ne jamais laisser une valeur de mot de passe, une ligne de commande ni une URL complète fuiter dans un message. */
function sanitize(msg) {
  let m = String(msg || "erreur inconnue").split("\n")[0];
  if (/\bsecurity\b.*\s-w\b|"password"\s*:|Command failed/i.test(m)) m = "opération Trousseau échouée (détail masqué)";
  return scrubUrls(m).slice(0, 300);
}
