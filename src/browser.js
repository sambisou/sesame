// Connexion à Chrome (protocole DevTools) et remplissage des champs.
// Chrome doit tourner avec --remote-debugging-port (voir `sesame chrome`).
import fs from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { CDP_URL, CHROME_PROFILE, siteMatchesUrl } from "./config.js";

// Champs de recherche et assimilés : jamais un identifiant.
const NOT_SEARCH = ':not([type="search"]):not([role="searchbox"]):not([name*="search" i]):not([id*="search" i]):not([name*="recherche" i]):not([id*="recherche" i]):not([name="q"]):not([placeholder*="recherch" i]):not([placeholder*="search" i])';
const USER_SELECTORS = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name*="email" i]', 'input[id*="email" i]',
  'input[name*="user" i]', 'input[id*="user" i]', 'input[name*="login" i]', 'input[id*="login" i]',
  'input[name*="identifiant" i]', 'input[id*="identifiant" i]',
  `input[type="tel"]${NOT_SEARCH}`,
  `input[type="text"]${NOT_SEARCH}`,
];
const PASS_SELECTORS = ['input[type="password"]'];
const SUBMIT_SELECTORS = [
  'button[type="submit"]', 'input[type="submit"]',
  'button:has-text("Se connecter")', 'button:has-text("Connexion")', 'button:has-text("Valider")',
  'button:has-text("Continuer")', 'button:has-text("Suivant")',
  'button:has-text("Sign in")', 'button:has-text("Log in")', 'button:has-text("Login")',
  'button:has-text("Next")', 'button:has-text("Continue")', 'button:has-text("Anmelden")', 'button:has-text("Weiter")',
];

// 2e facteur. Les sélecteurs FORTS suffisent seuls ; les FAIBLES doivent être corroborés par un texte explicite
// (sinon un code postal, un code promo ou une quantité passeraient pour un code de vérification).
const OTP_STRONG = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]', 'input[id*="otp" i]',
  'input[name*="totp" i]', 'input[id*="totp" i]',
  'input[name*="mfa" i]', 'input[id*="mfa" i]',
  'input[name*="2fa" i]', 'input[id*="2fa" i]',
  'input[name*="onetime" i]', 'input[id*="onetime" i]', 'input[name*="one-time" i]', 'input[id*="one-time" i]',
];
const OTP_WEAK = [
  'input[name*="verif" i]', 'input[id*="verif" i]',
  'input[name*="token" i]', 'input[id*="token" i]',
  'input[name*="code" i]', 'input[id*="code" i]', 'input[placeholder*="code" i]', 'input[aria-label*="code" i]',
  'input[inputmode="numeric"]', 'input[type="tel"]', 'input[type="text"]', 'input[type="number"]',
];
const OTP_TEXT = /code (de |d')?(vérification|verification|sécurité|securite|confirmation|validation|à usage unique|unique)|code (reçu|recu|envoyé|envoye|transmis)|(envoyé|envoye|reçu|recu) par (sms|e-?mail|courriel|mail)|code (à|a|de) \d+ chiffres|saisis(?:sez)? (?:le|votre) code|entrez (?:le|votre) code|verification code|security code|one-time (code|password)|\d[- ]digit code|code (that|we) sent|sent (you|to you) (a|the) code|enter (the|your|a) code|two-factor|2fa|deux facteurs|double authentification|authentification forte|authenticator/i;

async function cdpReachable() {
  try {
    const r = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/** Lance le Chrome « Sésame » (profil dédié, port DevTools) comme `sesame chrome`, et attend qu'il réponde. */
export async function launchChrome({ waitMs = 15000 } = {}) {
  const bin = process.env.SESAME_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!fs.existsSync(bin)) throw new Error("Google Chrome n'est pas dans /Applications : installe-le, ou lance le Chrome Sésame à la main.");
  const port = CDP_URL.split(":").pop();
  const child = spawn(bin, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${CHROME_PROFILE}`,
    "--no-first-run", "--no-default-browser-check", "--password-store=basic", "about:blank",
  ], { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await cdpReachable()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export async function connect() {
  // Chrome Sésame fermé : on le lance nous-mêmes (Sam n'a pas à passer par un terminal).
  if (!(await cdpReachable())) {
    const up = await launchChrome();
    if (!up) throw new Error(`Chrome Sésame ne répond pas sur ${CDP_URL} après lancement. Vérifie qu'un autre Chrome n'occupe pas le port.`);
  }
  try {
    return await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
  } catch (e) {
    // Chrome tourne mais n'a plus aucun onglet (dernière fenêtre fermée) : le protocole refuse la connexion.
    // On ouvre un onglet vide par l'API DevTools et on réessaie une fois.
    if (/context management is not supported/i.test(String(e.message))) {
      try {
        await fetch(`${CDP_URL}/json/new?about:blank`, { method: "PUT" });
        await new Promise(r => setTimeout(r, 800));
        return await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
      } catch {}
    }
    throw new Error(`Impossible de joindre Chrome sur ${CDP_URL}. Lance-le avec : sesame chrome`);
  }
}

export function allPages(browser) {
  return browser.contexts().flatMap(c => c.pages());
}

/** URL sans paramètres ni fragment : ce qui peut être journalisé ou renvoyé à l'IA (jamais un code OAuth ou un lien magique). */
export function publicUrl(u) {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u || "").split(/[?#]/)[0]; }
}

/** Une frame peut-elle recevoir des identifiants du site ? Frame principale, même site, ou frame vide héritant d'un parent autorisé. */
export function frameAllowed(site, frame) {
  if (!frame) return false;
  const page = frame.page();
  if (frame === page.mainFrame()) return true;
  const url = frame.url() || "";
  if (siteMatchesUrl(site, url)) return true;
  if (url === "" || url === "about:blank" || url === "about:srcdoc") return frameAllowed(site, frame.parentFrame());
  return false;
}

/** L'onglet (et la frame visée) sont-ils toujours sur le site ? Vérifié juste avant chaque frappe. */
export function onSite(page, site, frame) {
  if (page.isClosed()) return false;
  if (!siteMatchesUrl(site, page.url())) return false;
  return frame ? frameAllowed(site, frame) : true;
}

/** Trouve l'onglet correspondant au site (le plus récent d'abord), sinon null. */
export async function findPage(browser, site) {
  const pages = allPages(browser).filter(p => siteMatchesUrl(site, p.url()));
  if (pages.length === 0) return null;
  // On préfère un onglet qui montre un champ mot de passe, puis un champ identifiant plausible.
  for (const p of pages.slice().reverse()) if (await firstVisible(p, PASS_SELECTORS)) return p;
  for (const p of pages.slice().reverse()) if (await firstVisible(p, USER_SELECTORS)) return p;
  return pages[pages.length - 1];
}

/** L'onglet montre-t-il un formulaire de connexion (identifiant ou mot de passe) ? */
export async function hasLoginFields(page, site) {
  if (page.isClosed()) return false;
  if (await locate(page, site, site.selectors?.password, PASS_SELECTORS)) return true;
  return !!(await locate(page, site, site.selectors?.username, USER_SELECTORS));
}

/** Ramène un onglet du site sur sa page de connexion (session déjà ouverte, tableau de bord, page de déconnexion…). */
export async function gotoLogin(page, url, site) {
  // Certains liens de connexion déconnectent d'abord (page « vous êtes déconnecté ») et n'affichent le
  // formulaire qu'au passage suivant : on y retourne jusqu'à trois fois tant qu'aucun champ n'apparaît.
  for (let i = 0; i < 3; i++) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);
    if (!site || await hasLoginFields(page, site)) return true;
  }
  return false;
}

export async function openPage(browser, url) {
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  return page;
}

async function firstVisible(page, selectors, root = page) {
  for (const sel of selectors) {
    const loc = root.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false) && await el.isEditable().catch(() => true)) return el;
    }
  }
  return null;
}

/** Cherche dans la frame principale puis dans les iframes AUTORISÉES (même site). Renvoie { el, frame } ou null. */
async function locate(page, site, custom, fallbacks) {
  const sels = custom ? [custom] : fallbacks;
  if (page.isClosed()) return null;
  let el = await firstVisible(page, sels);
  if (el) return { el, frame: page.mainFrame() };
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || !frameAllowed(site, frame)) continue;
    el = await firstVisible(page, sels, frame);
    if (el) return { el, frame };
  }
  return null;
}

async function typeInto(el, value) {
  await el.click({ timeout: 5000 }).catch(() => {});
  await el.fill("", { timeout: 5000 }).catch(() => {});
  await el.fill(value, { timeout: 5000 });
}

/** Le bouton de soumission est cherché près du champ rempli (son <form>, puis ses conteneurs), pas n'importe où dans la page. */
async function submit(page, site, lastField) {
  if (site.selectors?.submit) {
    const hit = await locate(page, site, site.selectors.submit, []);
    if (hit) { await hit.el.click({ timeout: 5000 }).catch(() => {}); return "bouton"; }
  }
  if (lastField) {
    const form = lastField.locator("xpath=ancestor::form[1]");
    if ((await form.count().catch(() => 0)) > 0) {
      const btn = await firstVisible(page, SUBMIT_SELECTORS, form);
      if (btn) { await btn.click({ timeout: 5000 }).catch(() => {}); return "bouton"; }
    } else {
      for (let i = 1; i <= 6; i++) {
        const box = lastField.locator(`xpath=ancestor::*[${i}]`);
        if ((await box.count().catch(() => 0)) === 0) break;
        const btn = await firstVisible(page, SUBMIT_SELECTORS, box);
        if (btn) { await btn.click({ timeout: 5000 }).catch(() => {}); return "bouton"; }
      }
    }
    await lastField.press("Enter").catch(() => {});
    return "Entrée";
  }
  return "aucun";
}

/** Attend (jusqu'à `ms`) que le champ mot de passe disparaisse : la soumission a été prise en compte. */
async function waitPasswordGone(page, site, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (page.isClosed()) return true;
    if (!(await locate(page, site, site.selectors?.password, PASS_SELECTORS))) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function isSearchLike(el) {
  return el.evaluate(e => {
    const s = [e.type, e.name, e.id, e.placeholder, e.getAttribute("role"), e.getAttribute("aria-label"), e.autocomplete].join(" ").toLowerCase();
    return /search|recherch|\bq\b|username|email/.test(s) || e.type === "email";
  }).catch(() => false);
}

/**
 * Le site demande-t-il un code (2e facteur) ? Renvoie { kind, detail } ou null.
 *  - "champ"      : champ de code identifié (attente bloquante justifiée)
 *  - "texte-seul" : la page parle d'un code mais sans champ (choix de méthode, validation sur téléphone) → indice, pas d'attente
 */
export async function detectSecondFactor(page, site) {
  if (page.isClosed()) return null;
  if (await locate(page, site, site.selectors?.password, PASS_SELECTORS)) return null; // encore au mot de passe
  if (site.selectors?.code) {
    const hit = await locate(page, site, site.selectors.code, []);
    if (hit) return { kind: "champ", detail: "champ de code (sélecteur du site)" };
  }
  const strong = await locate(page, site, null, OTP_STRONG);
  if (strong && !(await isSearchLike(strong.el))) {
    const meta = await strong.el.evaluate(el => ({ type: el.type, ml: el.maxLength })).catch(() => ({}));
    return { kind: "champ", detail: `champ ${meta.type || "texte"}${meta.ml > 0 ? " (" + meta.ml + " car.)" : ""}` };
  }
  const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const m = bodyText.match(OTP_TEXT);
  if (!m) return null;
  const weak = await locate(page, site, null, OTP_WEAK);
  if (weak && !(await isSearchLike(weak.el))) return { kind: "champ", detail: `« ${m[0].trim()} »` };
  return { kind: "texte-seul", detail: `« ${m[0].trim()} »` };
}

/** Bandeau dans la page, là où l'utilisateur va taper le code. Silencieux si la page ne s'y prête pas. */
async function showBanner(page, text) {
  await page.evaluate(t => {
    let b = document.getElementById("sesame-banner");
    if (!b) {
      b = document.createElement("div");
      b.id = "sesame-banner";
      b.setAttribute("role", "status");
      b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:12px 18px;background:#1A1714;color:#F2EDE3;font:15px/1.4 -apple-system,Helvetica,Arial,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center";
      const dot = document.createElement("span");
      dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#D9A340;flex:none;animation:sesame-pulse 1.2s infinite";
      const st = document.createElement("style");
      st.textContent = "@keyframes sesame-pulse{0%,100%{opacity:1}50%{opacity:.25}}";
      b.appendChild(st); b.appendChild(dot);
      const span = document.createElement("span"); span.id = "sesame-banner-text"; b.appendChild(span);
      document.documentElement.appendChild(b);
    }
    document.getElementById("sesame-banner-text").textContent = t;
  }, text).catch(() => {});
}
async function hideBanner(page) {
  await page.evaluate(() => document.getElementById("sesame-banner")?.remove()).catch(() => {});
}

/**
 * Attend que l'utilisateur saisisse le code du 2e facteur et que le site l'accepte.
 * Fin « done » : plus aucun champ de code ni de mot de passe, deux contrôles de suite, onglet toujours sur le site.
 * Fin « échec » : onglet fermé ou parti ailleurs, retour au formulaire mot de passe (code refusé), ou délai.
 * Renvoie { done, elapsedSec, reason? }.
 */
export async function waitForSecondFactor(page, site, { timeoutSec = 180, message, onTick } = {}) {
  const started = Date.now();
  const deadline = started + timeoutSec * 1000;
  const banner = message || `Sésame attend que vous saisissiez le code reçu par e-mail, SMS ou application. La connexion reprendra toute seule dès que le site l'aura accepté (encore ${timeoutSec} s).`;
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  let clear = 0;
  await page.bringToFront().catch(() => {}); // ici, oui : l'utilisateur doit taper le code
  await showBanner(page, banner);
  while (Date.now() < deadline) {
    if (page.isClosed()) return { done: false, elapsedSec: elapsed(), reason: "onglet fermé pendant l'attente du code" };
    if (!siteMatchesUrl(site, page.url())) return { done: false, elapsedSec: elapsed(), reason: `onglet parti vers ${publicUrl(page.url())}` };
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const pwd = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
    if (pwd) { await hideBanner(page); return { done: false, elapsedSec: elapsed(), reason: "retour au formulaire mot de passe (code refusé ?)" }; }
    const still = await detectSecondFactor(page, site);
    if (!still || still.kind === "texte-seul") { clear++; } else { clear = 0; }
    if (clear >= 2) {
      await hideBanner(page);
      return { done: true, elapsedSec: elapsed() };
    }
    if (onTick) { try { await onTick(remaining); } catch {} }
    await showBanner(page, banner.replace(/encore \d+ s/, `encore ${remaining} s`));
    await page.waitForTimeout(1000);
  }
  await hideBanner(page);
  return { done: false, elapsedSec: timeoutSec, reason: "délai dépassé" };
}

/**
 * Remplit identifiant + mot de passe dans la page, gère les connexions en deux étapes
 * (identifiant → Continuer → mot de passe) et, si le site demande un code (2e facteur),
 * prévient l'utilisateur et attend qu'il le saisisse avant de rendre la main. Ne renvoie JAMAIS les valeurs.
 * Avant chaque frappe, l'onglet et la frame sont revérifiés : toujours sur le site, sinon abandon.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.submitForm=true]
 * @param {boolean} [opts.waitSecondFactor=true]  attendre le code si le site en demande un
 * @param {number}  [opts.secondFactorTimeoutSec=180]
 * @param {(info:{kind:string,detail:string}) => void} [opts.onSecondFactor]  appelé quand un code est demandé (notification, journal)
 */
export async function fillLogin(page, site, secret, { submitForm = true, waitSecondFactor = true, secondFactorTimeoutSec = 180, onSecondFactor } = {}) {
  const steps = [];
  const where = frame => (frame && frame !== page.mainFrame() ? ` (iframe ${publicUrl(frame.url())})` : "");
  const gone = hostname => ({ ok: false, steps, url: publicUrl(page.isClosed() ? "" : page.url()), reason: `onglet parti vers ${hostname || "une autre page"} : remplissage abandonné` });
  const bail = () => gone(page.isClosed() ? "(onglet fermé)" : publicUrl(page.url()));

  // Pas de passage au premier plan : la connexion se fait en arrière-plan, Chrome ne vient devant que pour un code.
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});

  let user = secret.username ? await locate(page, site, site.selectors?.username, USER_SELECTORS) : null;
  let pass = await locate(page, site, site.selectors?.password, PASS_SELECTORS);

  if (!user && !pass) {
    // Parfois le formulaire arrive après un clic "Se connecter" : on attend un peu.
    await page.waitForTimeout(1500);
    user = secret.username ? await locate(page, site, site.selectors?.username, USER_SELECTORS) : null;
    pass = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
  }
  if (!user && !pass) {
    return { ok: false, steps, reason: "Aucun champ identifiant/mot de passe visible sur cet onglet. Ouvre la page de connexion d'abord (sesame_open_login)." };
  }

  if (user) {
    if (!onSite(page, site, user.frame)) return bail();
    await typeInto(user.el, secret.username);
    steps.push(`identifiant rempli${where(user.frame)}`);
  }

  if (!pass && user) {
    // Connexion en deux étapes : on valide l'identifiant et on attend le mot de passe.
    const how = await submit(page, site, user.el);
    steps.push(`étape 1 validée (${how})`);
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 20 && !pass; i++) {
      await page.waitForTimeout(500);
      if (page.isClosed() || !siteMatchesUrl(site, page.url())) return bail();
      pass = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
    }
    if (!pass) return { ok: false, steps, url: publicUrl(page.url()), reason: "Le champ mot de passe n'est pas apparu après l'identifiant (captcha, code SMS, ou sélecteur à préciser)." };
  }

  if (!onSite(page, site, pass.frame)) return bail();
  await typeInto(pass.el, secret.password);
  steps.push(`mot de passe rempli${where(pass.frame)}`);

  let secondFactor = null;
  let hint;
  if (submitForm) {
    const how = await submit(page, site, pass.el);
    steps.push(`formulaire soumis (${how})`);
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    // Laisser le site basculer avant de juger : mot de passe refusé ou 2e facteur ?
    const passwordGone = await waitPasswordGone(page, site, 8000);
    if (!passwordGone) {
      // Le formulaire est toujours là : on ne laisse pas le mot de passe dans la page.
      const still = await locate(page, site, site.selectors?.password, PASS_SELECTORS);
      if (still) await still.el.fill("").catch(() => {});
      hint = "Un champ mot de passe est encore visible : identifiants refusés ou captcha probable (champ vidé).";
    } else if (!page.isClosed()) {
      await page.waitForTimeout(800);
      const sf = await detectSecondFactor(page, site);
      if (sf && sf.kind === "texte-seul") {
        steps.push(`la page évoque un code (${sf.detail}) sans champ de saisie`);
        hint = "La page évoque un 2e facteur sans champ visible (validation sur téléphone ? choix de méthode ?) : vérifie l'onglet, puis appelle sesame_wait_code une fois le champ de code affiché.";
      } else if (sf) {
        steps.push(`code demandé par le site (${sf.detail})`);
        if (onSecondFactor) { try { await onSecondFactor(sf); } catch {} }
        if (waitSecondFactor) {
          const w = await waitForSecondFactor(page, site, { timeoutSec: secondFactorTimeoutSec });
          if (!w.done) {
            const pending = w.reason === "délai dépassé";
            return {
              ok: false, steps, url: publicUrl(page.isClosed() ? "" : page.url()),
              reason: pending
                ? `L'utilisateur n'a pas saisi le code dans le délai (${secondFactorTimeoutSec} s). Le formulaire est toujours ouvert : appelle sesame_wait_code quand l'utilisateur est prêt.`
                : `Attente du code interrompue : ${w.reason}.`,
              secondFactor: { pending, ...sf },
            };
          }
          steps.push(`code saisi par l'utilisateur, connexion poursuivie (${w.elapsedSec} s)`);
          secondFactor = { pending: false, ...sf };
          await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(800);
        } else {
          secondFactor = { pending: true, ...sf };
          hint = "Le site attend un code (2e facteur) : l'utilisateur doit le saisir dans le Chrome Sésame, puis appelle sesame_wait_code.";
        }
      }
    }
  }

  return {
    ok: true,
    steps,
    url: publicUrl(page.isClosed() ? "" : page.url()),
    title: page.isClosed() ? "" : await page.title().catch(() => ""),
    secondFactor: secondFactor || undefined,
    hint,
  };
}
