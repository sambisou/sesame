// Connexion à Chrome (protocole DevTools) et remplissage des champs.
// Chrome doit tourner avec --remote-debugging-port (voir `sesame chrome`).
import { chromium } from "playwright-core";
import { CDP_URL, siteMatchesUrl } from "./config.js";

const USER_SELECTORS = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name*="email" i]', 'input[id*="email" i]',
  'input[name*="user" i]', 'input[id*="user" i]', 'input[name*="login" i]', 'input[id*="login" i]',
  'input[name*="identifiant" i]', 'input[id*="identifiant" i]',
  'input[type="tel"]',
  'input[type="text"]',
];
const PASS_SELECTORS = ['input[type="password"]'];
const SUBMIT_SELECTORS = [
  'button[type="submit"]', 'input[type="submit"]',
  'button:has-text("Se connecter")', 'button:has-text("Connexion")', 'button:has-text("Valider")',
  'button:has-text("Continuer")', 'button:has-text("Suivant")',
  'button:has-text("Sign in")', 'button:has-text("Log in")', 'button:has-text("Login")',
  'button:has-text("Next")', 'button:has-text("Continue")', 'button:has-text("Anmelden")', 'button:has-text("Weiter")',
];

// 2e facteur : champs typiques d'un code à usage unique (SMS, e-mail, application).
const OTP_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]', 'input[id*="otp" i]',
  'input[name*="totp" i]', 'input[id*="totp" i]',
  'input[name*="mfa" i]', 'input[id*="mfa" i]',
  'input[name*="2fa" i]', 'input[id*="2fa" i]',
  'input[name*="verif" i]', 'input[id*="verif" i]',
  'input[name*="token" i]', 'input[id*="token" i]',
  'input[name*="code" i]', 'input[id*="code" i]', 'input[placeholder*="code" i]', 'input[aria-label*="code" i]',
  'input[inputmode="numeric"]',
];
// Formulations fortes seulement, pour éviter de prendre un tableau de bord pour une page de code.
const OTP_TEXT = /code (de |d')?(vérification|verification|sécurité|securite|confirmation|validation|à usage unique|unique)|code (reçu|recu|envoyé|envoye|transmis)|(envoyé|envoye|reçu|recu) par (sms|e-?mail|courriel|mail)|verification code|security code|one-time (code|password)|two-factor|2fa|deux facteurs|double authentification|authentification forte|authenticator/i;

export async function connect() {
  try {
    return await chromium.connectOverCDP(CDP_URL, { timeout: 5000 });
  } catch (e) {
    throw new Error(`Impossible de joindre Chrome sur ${CDP_URL}. Lance-le avec : sesame chrome`);
  }
}

export function allPages(browser) {
  return browser.contexts().flatMap(c => c.pages());
}

/** Trouve l'onglet correspondant au site (le plus récent d'abord), sinon null. */
export async function findPage(browser, site) {
  const pages = allPages(browser).filter(p => siteMatchesUrl(site, p.url()));
  if (pages.length === 0) return null;
  // On préfère un onglet qui contient déjà un champ mot de passe ou identifiant.
  for (const p of pages.slice().reverse()) {
    if (await firstVisible(p, PASS_SELECTORS) || await firstVisible(p, USER_SELECTORS)) return p;
  }
  return pages[pages.length - 1];
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

/** Cherche dans la page principale puis dans les iframes (widgets de connexion). */
async function locate(page, custom, fallbacks) {
  const sels = custom ? [custom] : fallbacks;
  let el = await firstVisible(page, sels);
  if (el) return el;
  for (const frame of page.frames().slice(1)) {
    el = await firstVisible(page, sels, frame);
    if (el) return el;
  }
  return null;
}

async function typeInto(el, value) {
  await el.click({ timeout: 5000 }).catch(() => {});
  await el.fill("", { timeout: 5000 }).catch(() => {});
  await el.fill(value, { timeout: 5000 });
}

async function submit(page, site, lastField) {
  const btn = site.selectors?.submit ? await locate(page, site.selectors.submit, []) : await locate(page, null, SUBMIT_SELECTORS);
  if (btn) { await btn.click({ timeout: 5000 }).catch(() => {}); return "bouton"; }
  if (lastField) { await lastField.press("Enter").catch(() => {}); return "Entrée"; }
  return "aucun";
}

/** Attend (jusqu'à `ms`) que le champ mot de passe disparaisse : la soumission a été prise en compte. */
async function waitPasswordGone(page, site, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (page.isClosed()) return true;
    if (!(await locate(page, site.selectors?.password, PASS_SELECTORS))) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

/**
 * Le site demande-t-il un code (2e facteur) ? Renvoie une description ou null.
 * Détection : un champ typique de code (sélecteurs), ou un champ court + un texte explicite.
 */
export async function detectSecondFactor(page, site) {
  if (page.isClosed()) return null;
  if (await locate(page, site.selectors?.password, PASS_SELECTORS)) return null; // encore au mot de passe
  const custom = site.selectors?.code;
  const byField = await locate(page, custom, OTP_SELECTORS);
  if (byField) {
    const meta = await byField.evaluate(el => ({ type: el.type, ac: el.autocomplete, ml: el.maxLength })).catch(() => ({}));
    if (meta.type !== "email" && meta.ac !== "username") return { kind: "champ", detail: `champ ${meta.type || "texte"}${meta.ml > 0 ? " (" + meta.ml + " car.)" : ""}` };
  }
  const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const m = bodyText.match(OTP_TEXT);
  if (m) {
    const short = await firstVisible(page, ['input[type="text"]', 'input[type="tel"]', 'input[type="number"]']);
    if (short) return { kind: "texte", detail: `« ${m[0].trim()} »` };
  }
  return null;
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
 * Fin : plus aucun champ de code ni de mot de passe visible pendant deux contrôles consécutifs
 * (ou page fermée). Renvoie { done, elapsedSec }.
 */
export async function waitForSecondFactor(page, site, { timeoutSec = 180, message, onTick } = {}) {
  const started = Date.now();
  const deadline = started + timeoutSec * 1000;
  const banner = message || `Sésame attend que vous saisissiez le code reçu par e-mail, SMS ou application. La connexion reprendra toute seule dès que le site l'aura accepté (encore ${timeoutSec} s).`;
  let clear = 0;
  await showBanner(page, banner);
  while (Date.now() < deadline) {
    if (page.isClosed()) return { done: true, elapsedSec: Math.round((Date.now() - started) / 1000) };
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const still = await detectSecondFactor(page, site);
    const pwd = await locate(page, site.selectors?.password, PASS_SELECTORS);
    if (!still && !pwd) { clear++; } else { clear = 0; }
    if (clear >= 2) {
      await hideBanner(page);
      return { done: true, elapsedSec: Math.round((Date.now() - started) / 1000) };
    }
    if (onTick) { try { await onTick(remaining); } catch {} }
    await showBanner(page, banner.replace(/encore \d+ s/, `encore ${remaining} s`));
    await page.waitForTimeout(1000);
  }
  await hideBanner(page);
  return { done: false, elapsedSec: timeoutSec };
}

/**
 * Remplit identifiant + mot de passe dans la page, gère les connexions en deux étapes
 * (identifiant → Continuer → mot de passe) et, si le site demande un code (2e facteur),
 * prévient l'utilisateur et attend qu'il le saisisse avant de rendre la main. Ne renvoie JAMAIS les valeurs.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.submitForm=true]
 * @param {boolean} [opts.waitSecondFactor=true]  attendre le code si le site en demande un
 * @param {number}  [opts.secondFactorTimeoutSec=180]
 * @param {(info:{kind:string,detail:string}) => void} [opts.onSecondFactor]  appelé quand un code est demandé (notification, journal)
 */
export async function fillLogin(page, site, secret, { submitForm = true, waitSecondFactor = true, secondFactorTimeoutSec = 180, onSecondFactor } = {}) {
  const steps = [];
  await page.bringToFront().catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});

  let userEl = secret.username ? await locate(page, site.selectors?.username, USER_SELECTORS) : null;
  let passEl = await locate(page, site.selectors?.password, PASS_SELECTORS);

  if (!userEl && !passEl) {
    // Parfois le formulaire arrive après un clic "Se connecter" : on attend un peu.
    await page.waitForTimeout(1500);
    userEl = secret.username ? await locate(page, site.selectors?.username, USER_SELECTORS) : null;
    passEl = await locate(page, site.selectors?.password, PASS_SELECTORS);
  }
  if (!userEl && !passEl) {
    return { ok: false, steps, reason: "Aucun champ identifiant/mot de passe visible sur cet onglet. Ouvre la page de connexion d'abord (sesame_open_login)." };
  }

  if (userEl) {
    await typeInto(userEl, secret.username);
    steps.push("identifiant rempli");
  }

  if (!passEl && userEl) {
    // Connexion en deux étapes : on valide l'identifiant et on attend le mot de passe.
    const how = await submit(page, site, userEl);
    steps.push(`étape 1 validée (${how})`);
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 20 && !passEl; i++) {
      await page.waitForTimeout(500);
      passEl = await locate(page, site.selectors?.password, PASS_SELECTORS);
    }
    if (!passEl) return { ok: false, steps, reason: "Le champ mot de passe n'est pas apparu après l'identifiant (captcha, code SMS, ou sélecteur à préciser)." };
  }

  await typeInto(passEl, secret.password);
  steps.push("mot de passe rempli");

  let secondFactor = null;
  if (submitForm) {
    const how = await submit(page, site, passEl);
    steps.push(`formulaire soumis (${how})`);
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    // Laisser le site basculer avant de juger : mot de passe refusé ou 2e facteur ?
    const gone = await waitPasswordGone(page, site, 8000);
    if (gone) {
      await page.waitForTimeout(800);
      const sf = await detectSecondFactor(page, site);
      if (sf) {
        steps.push(`code demandé par le site (${sf.detail})`);
        if (onSecondFactor) { try { await onSecondFactor(sf); } catch {} }
        if (waitSecondFactor) {
          const w = await waitForSecondFactor(page, site, { timeoutSec: secondFactorTimeoutSec });
          if (!w.done) {
            return {
              ok: false, steps, url: page.url(),
              reason: `L'utilisateur n'a pas saisi le code dans le délai (${secondFactorTimeoutSec} s). Le formulaire est toujours ouvert : appelle sesame_wait_code quand l'utilisateur est prêt.`,
              secondFactor: { pending: true, ...sf },
            };
          }
          steps.push(`code saisi par l'utilisateur, connexion poursuivie (${w.elapsedSec} s)`);
          secondFactor = { pending: false, ...sf };
          await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(800);
        } else {
          secondFactor = { pending: true, ...sf };
        }
      }
    }
  }

  const stillPassword = submitForm ? await locate(page, site.selectors?.password, PASS_SELECTORS) : null;
  return {
    ok: true,
    steps,
    url: page.url(),
    title: await page.title().catch(() => ""),
    secondFactor: secondFactor || undefined,
    hint: stillPassword ? "Un champ mot de passe est encore visible : identifiants refusés ou captcha probable."
      : secondFactor?.pending ? "Le site attend un code (2e facteur) : l'utilisateur doit le saisir dans le Chrome Sésame, puis appelle sesame_wait_code."
      : undefined,
  };
}
