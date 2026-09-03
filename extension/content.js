// Sésame — script de contenu.
//
// Injecté À LA DEMANDE par le service worker (chrome.scripting.executeScript, fichier), jamais déclaré dans le
// manifeste : il n'est présent dans une page que pendant une connexion que l'utilisateur a validée.
// Il porte en DOM pur les heuristiques de src/browser.js (fillLogin, detectSecondFactor, waitForSecondFactor) :
// le service worker orchestre (onglets, frames, navigations, délais), ce script agit dans UNE frame et
// répond à ses messages (chrome.tabs.sendMessage ciblé sur la frame).
//
// Règles :
//  - il ne renvoie JAMAIS la valeur d'un champ (ni identifiant, ni mot de passe, ni code) et n'écrit rien
//    dans la console ;
//  - il refuse toute action si sa frame n'appartient pas au site visé, frame principale comprise : hôte = site
//    (ou sous-domaine) ET https (http toléré pour 127.0.0.1/localhost, bancs d'essai) ; iframe du même site, ou
//    iframe vide héritant d'un parent autorisé — comme frameAllowed() côté serveur ;
//  - le code du 2e facteur est tapé par l'humain : ce script ne le lit pas, il constate seulement que le
//    champ de code a disparu.
(() => {
  if (globalThis.__sesameContent) return; // déjà injecté dans ce document (sondages répétés)
  globalThis.__sesameContent = true;

  // ------------------------------------------------------------------------------------------
  // Sélecteurs — copie fidèle de src/browser.js
  // ------------------------------------------------------------------------------------------
  // Champs de recherche et assimilés : jamais un identifiant.
  const NOT_SEARCH = ':not([type="search"]):not([role="searchbox"]):not([name*="search" i]):not([id*="search" i]):not([name*="recherche" i]):not([id*="recherche" i]):not([name="q"]):not([placeholder*="recherch" i]):not([placeholder*="search" i])';
  // Champs identifiant FORTS (suffisent seuls) et FAIBLES (un simple champ texte : accepté seulement sur la page de
  // connexion déclarée, ou à côté d'un champ mot de passe — le service worker tranche, voir pickUser).
  const USER_STRONG = [
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[name*="email" i]', 'input[id*="email" i]',
    'input[name*="user" i]', 'input[id*="user" i]', 'input[name*="login" i]', 'input[id*="login" i]',
    'input[name*="identifiant" i]', 'input[id*="identifiant" i]',
  ];
  const USER_WEAK = [`input[type="tel"]${NOT_SEARCH}`, `input[type="text"]${NOT_SEARCH}`];
  const PASS_SELECTORS = ['input[type="password"]'];
  // Playwright acceptait `button:has-text("…")` ; ici, un sélecteur CSS + un texte à contenir (insensible à la casse).
  const SUBMIT_SELECTORS = [
    { css: 'button[type="submit"]' }, { css: 'input[type="submit"]' },
    ...["Se connecter", "Connexion", "Valider", "Continuer", "Suivant",
      "Sign in", "Log in", "Login", "Next", "Continue", "Anmelden", "Weiter"].map(text => ({ css: "button", text })),
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

  // ------------------------------------------------------------------------------------------
  // Site et frame
  // ------------------------------------------------------------------------------------------
  function hostnameOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
  }
  /** URL sans paramètres ni fragment : la seule forme qui puisse quitter la page (jamais un code OAuth ni un lien magique). */
  function publicUrl(u) {
    try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u || "").split(/[?#]/)[0]; }
  }
  function matchesSite(site, host) {
    if (!host) return false;
    const domains = [site.domain, ...(Array.isArray(site.extraDomains) ? site.extraDomains : [])].filter(Boolean);
    return domains.some(d => host === d || host.endsWith("." + d));
  }
  const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1"];
  /** Une frame reçoit un identifiant seulement en https (http toléré pour un hôte local : bancs d'essai) ET sur le site. null si la frame n'a pas d'hôte (about:blank, srcdoc). */
  function originAllowed(site, loc) {
    const host = (loc.hostname || "").replace(/^www\./, "");
    if (!host) return null;
    const secure = loc.protocol === "https:" || (loc.protocol === "http:" && LOCAL_HOSTS.includes(loc.hostname));
    return secure && matchesSite(site, host);
  }
  /**
   * Cette frame peut-elle recevoir des identifiants du site ? Frame principale : oui si elle est en https ET
   * sur le site (ou un sous-domaine) — la frame principale n'est jamais crue sur parole : une navigation vers un
   * autre domaine entre deux frappes doit être refusée ici même. Iframe : même règle sur son propre hôte, ou
   * frame vide (about:blank, srcdoc) héritant d'un parent autorisé — un parent d'une autre origine est
   * inaccessible (exception) et donc refusé.
   */
  function frameAllowed(site) {
    if (window === window.top) return originAllowed(site, location) === true;
    const own = originAllowed(site, location);
    if (own !== null) return own;
    // about:blank / about:srcdoc : on remonte jusqu'à un parent qui a un hôte (jusqu'à la frame principale incluse).
    try {
      let w = window;
      while (w !== w.top) {
        w = w.parent;
        const r = originAllowed(site, w.location);
        if (r !== null) return r;
      }
      return false; // même la frame principale n'a pas d'hôte : rien à quoi rattacher cette frame
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Recherche d'éléments (document + racines Shadow DOM ouvertes, comme les locators Playwright)
  // ------------------------------------------------------------------------------------------
  let rootsCache = null; // racines du document, calculées une fois par opération
  function rootsOf(root) {
    if (root === document && rootsCache) return rootsCache;
    const roots = [root];
    const stack = [root];
    while (stack.length && roots.length < 60) {
      const r = stack.pop();
      let all;
      try { all = r.querySelectorAll("*"); } catch { continue; }
      for (const el of all) {
        if (el.shadowRoot) { roots.push(el.shadowRoot); stack.push(el.shadowRoot); if (roots.length >= 60) break; }
      }
    }
    if (root === document) rootsCache = roots;
    return roots;
  }
  function queryAll(css, root) {
    const out = [];
    for (const r of rootsOf(root)) {
      try { for (const el of r.querySelectorAll(css)) out.push(el); } catch { /* sélecteur invalide : ignoré */ }
    }
    return out;
  }
  function textOf(el) {
    return String(el.innerText ?? el.textContent ?? el.value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  /** Candidats pour une entrée de sélecteur : chaîne CSS, ou { css, text } (texte contenu, insensible à la casse). */
  function candidates(entry, root) {
    if (typeof entry === "string") return queryAll(entry, root);
    const list = queryAll(entry.css, root);
    if (!entry.text) return list;
    const t = entry.text.toLowerCase();
    return list.filter(el => textOf(el).includes(t));
  }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  function editable(el) { return !el.disabled && !el.readOnly; }
  /** Premier élément visible et actif parmi les sélecteurs, dans l'ordre ; 5 candidats examinés par sélecteur (comme firstVisible côté serveur). */
  function firstVisible(entries, root = document) {
    for (const entry of entries) {
      let n = 0;
      for (const el of candidates(entry, root)) {
        if (n++ >= 5) break;
        if (visible(el) && editable(el)) return el;
      }
    }
    return null;
  }
  function locate(custom, fallbacks) { return firstVisible(custom ? [custom] : fallbacks); }
  function locatePass(site) { return locate(site.selectors?.password, PASS_SELECTORS); }
  /** Le service worker a choisi la classe de sélecteurs (custom / strong / weak) d'après le sondage ; on la rejoue ici. */
  function locateUser(site, mode) {
    if (mode === "custom") return locate(site.selectors?.username, []);
    if (mode === "strong") return firstVisible(USER_STRONG);
    if (mode === "weak") return firstVisible(USER_WEAK);
    return null;
  }
  function isSearchLike(e) {
    const s = [e.type, e.name, e.id, e.placeholder, e.getAttribute("role"), e.getAttribute("aria-label"), e.autocomplete].join(" ").toLowerCase();
    return /search|recherch|\bq\b|username|email/.test(s) || e.type === "email";
  }

  // ------------------------------------------------------------------------------------------
  // Actions : frappe, soumission
  // ------------------------------------------------------------------------------------------
  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true, composed: true })); }
  /** Affecte la valeur par le setter natif (les frameworks qui remplacent `value` — React — voient quand même le changement). */
  function setNative(el, v) {
    const proto = Object.getPrototypeOf(el);
    const d = Object.getOwnPropertyDescriptor(proto, "value") || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (d && d.set) d.set.call(el, v); else el.value = v;
  }
  /** Équivalent de click + fill("") + fill(valeur) : vide, puis insère comme une frappe (beforeinput/input), sinon setter natif. */
  function typeInto(el, value) {
    try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch {}
    try { el.click(); } catch {}
    try { el.focus(); } catch {}
    setNative(el, "");
    fire(el, "input");
    let ok = false;
    try { ok = document.activeElement === el && document.execCommand("insertText", false, value); } catch { ok = false; }
    if (!ok || el.value !== value) {
      setNative(el, value);
      fire(el, "input");
    }
    fire(el, "change");
  }
  function clickEl(el) {
    try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch {}
    el.click();
  }
  /** Touche Entrée : événements clavier, puis soumission du formulaire si personne ne s'y oppose (la soumission implicite ne se déclenche pas sur un événement synthétique). */
  function pressEnter(el) {
    const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const notPrevented = el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    const form = el.form || el.closest("form");
    if (notPrevented && form) {
      try { if (typeof form.requestSubmit === "function") form.requestSubmit(); else form.submit(); } catch {}
    }
  }
  /** Parent DOM en traversant les racines Shadow (hôte) : pour remonter les conteneurs d'un champ sans formulaire. */
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }
  /** Le bouton de soumission est cherché près du champ rempli (son <form>, puis ses conteneurs), pas n'importe où dans la page. */
  function submitNear(site, lastField) {
    if (site.selectors?.submit) {
      const hit = locate(site.selectors.submit, []);
      if (hit) { clickEl(hit); return "bouton"; }
    }
    if (lastField) {
      const form = lastField.form || lastField.closest("form");
      if (form) {
        const btn = firstVisible(SUBMIT_SELECTORS, form);
        if (btn) { clickEl(btn); return "bouton"; }
      } else {
        let box = lastField;
        for (let i = 1; i <= 6; i++) {
          box = parentOf(box);
          if (!box) break;
          const btn = firstVisible(SUBMIT_SELECTORS, box);
          if (btn) { clickEl(btn); return "bouton"; }
        }
      }
      pressEnter(lastField);
      return "Entrée";
    }
    return "aucun";
  }

  // ------------------------------------------------------------------------------------------
  // Bandeau d'attente du code (frame principale) : hôte au nom aléatoire, contenu dans un shadow root FERMÉ.
  // La page ne peut ni lire le texte, ni le retirer par un sélecteur connu, ni l'imiter à l'identique ; seule
  // la référence gardée ici y accède. Le service worker le retire dans tous les cas (finally), et double le
  // signal hors de la page (badge de l'action, notification système).
  // ------------------------------------------------------------------------------------------
  let bannerHost = null, bannerText = null;
  function randomTag() {
    const a = new Uint8Array(6); crypto.getRandomValues(a);
    return "s" + Array.from(a, b => (b % 26 + 10).toString(36)).join("") + "-" + Math.random().toString(36).slice(2, 8);
  }
  function showBanner(text) {
    if (!bannerHost || !bannerHost.isConnected) {
      const host = document.createElement(randomTag()); // nom d'élément personnalisé valide (tiret) : attachShadow autorisé
      host.style.cssText = "all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;display:block";
      const root = host.attachShadow({ mode: "closed" });
      const st = document.createElement("style");
      st.textContent = ":host{all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;display:block}.b{padding:12px 18px;background:#1A1714;color:#F2EDE3;font:15px/1.4 -apple-system,Helvetica,Arial,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center}.d{width:10px;height:10px;border-radius:50%;background:#D9A340;flex:none;animation:p 1.2s infinite}@keyframes p{0%,100%{opacity:1}50%{opacity:.25}}";
      const b = document.createElement("div"); b.className = "b"; b.setAttribute("role", "status");
      const dot = document.createElement("span"); dot.className = "d";
      const span = document.createElement("span");
      b.appendChild(dot); b.appendChild(span);
      root.appendChild(st); root.appendChild(b);
      document.documentElement.appendChild(host);
      bannerHost = host; bannerText = span;
    }
    bannerText.textContent = text;
  }
  function hideBanner() { if (bannerHost) { bannerHost.remove(); bannerHost = null; bannerText = null; } }

  // ------------------------------------------------------------------------------------------
  // Opérations demandées par le service worker. Chacune renvoie un objet SANS aucune valeur de champ.
  // ------------------------------------------------------------------------------------------
  const ops = {
    /** Sondage : la frame est-elle autorisée, et montre-t-elle des champs de connexion ? */
    probe(msg) {
      const site = msg.site;
      const base = { allowed: frameAllowed(site), isTop: window === window.top, url: publicUrl(location.href) };
      if (!base.allowed) return base;
      const out = { ...base, pass: !!locatePass(site), userCustom: false, userStrong: false, userWeak: false };
      if (site.selectors?.username) out.userCustom = !!locate(site.selectors.username, []);
      else { out.userStrong = !!firstVisible(USER_STRONG); out.userWeak = !!firstVisible(USER_WEAK); }
      return out;
    },
    /** Tape l'identifiant, et valide l'étape si demandé (connexion en deux temps). */
    fillUser(msg) {
      const el = locateUser(msg.site, msg.mode);
      if (!el) return { ok: false, error: "champ identifiant introuvable au moment de la frappe" };
      typeInto(el, msg.username);
      const how = msg.submit ? submitNear(msg.site, el) : null;
      return { ok: true, how };
    },
    /** Tape le mot de passe, et soumet si demandé. */
    fillPassword(msg) {
      const el = locatePass(msg.site);
      if (!el) return { ok: false, error: "champ mot de passe introuvable au moment de la frappe" };
      typeInto(el, msg.password);
      const how = msg.submit ? submitNear(msg.site, el) : null;
      return { ok: true, how };
    },
    /** Vide le champ mot de passe (soumission refusée : on ne laisse pas le secret dans la page). */
    clearPassword(msg) {
      const el = locatePass(msg.site);
      if (!el) return { ok: true, cleared: false };
      setNative(el, ""); fire(el, "input"); fire(el, "change");
      return { ok: true, cleared: true };
    },
    /** Éléments de détection du 2e facteur ; le service worker les combine sur toutes les frames autorisées. */
    sfProbe(msg) {
      const site = msg.site;
      const isTop = window === window.top;
      const out = { allowed: frameAllowed(site), isTop, url: publicUrl(location.href) };
      if (!out.allowed) return out;
      out.pass = !!locatePass(site);
      out.customCode = site.selectors?.code ? !!locate(site.selectors.code, []) : false;
      const s = firstVisible(OTP_STRONG);
      out.strong = s ? { searchLike: isSearchLike(s), type: s.type || "texte", ml: s.maxLength > 0 ? s.maxLength : 0 } : null;
      // Le texte de la page n'est lu que dans la frame principale (comme page.evaluate côté serveur) ; seul l'extrait
      // qui a déclenché la détection est renvoyé, jamais le contenu de la page.
      let text = null;
      if (isTop) { const m = String(document.body?.innerText || "").match(OTP_TEXT); text = m ? m[0].trim() : null; }
      out.text = text;
      const w = firstVisible(OTP_WEAK);
      out.weak = !!(w && !isSearchLike(w));
      return out;
    },
    banner(msg) { showBanner(String(msg.text || "")); return { ok: true }; },
    hideBanner() { hideBanner(); return { ok: true }; },
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Seuls les messages du service worker de CETTE extension (tabs.sendMessage) sont écoutés.
    if (!msg || msg.__sesame !== true || sender.id !== chrome.runtime.id) return;
    let out;
    rootsCache = null;
    try {
      const op = ops[msg.op];
      if (!op) out = { ok: false, error: "opération inconnue" };
      // Les sondages répondent « allowed:false » eux-mêmes ; retirer notre propre bandeau est toujours permis ; tout le reste exige une frame du site.
      else if (msg.op !== "probe" && msg.op !== "sfProbe" && msg.op !== "hideBanner" && !frameAllowed(msg.site || {})) out = { ok: false, allowed: false, error: "frame hors du site : action refusée" };
      else out = op(msg);
    } catch (e) {
      out = { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
    } finally {
      // Le secret ne survit pas à l'opération.
      if ("username" in msg) msg.username = null;
      if ("password" in msg) msg.password = null;
      rootsCache = null;
    }
    sendResponse(out);
  });
})();
