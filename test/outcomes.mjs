// Codes de résultat lisibles par machine (spécification « connexions robustes », étape 1, §1 et §3) :
// Sésame dit EXACTEMENT ce qui s'est passé — mot de passe refusé, captcha, formulaire inchangé, connexion
// ouverte dès l'identifiant, formulaire encore affiché pendant une attente de code — et chaque réponse porte
// `outcome`, `code`, `retry`, `actor`. Chrome de test headless (port et profil dédiés) + pages locales :
// ne touche ni ~/.sesame ni le Chrome de Sam.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import assert from "node:assert/strict";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-outcomes-"));
process.env.SESAME_HOME = HOME;
process.env.SESAME_KEYCHAIN_SERVICE = "sesame-outcomes-" + process.pid;
process.env.SESAME_CDP_URL = "http://127.0.0.1:9241";
process.env.SESAME_CHROME_HEADLESS = "1";   // aucun Chrome ne doit surgir à l'écran pendant les tests
process.env.SESAME_NO_LOCK = "1";           // ce banc enchaîne des échecs volontaires : pas de verrou d'essais (§4)
setTimeout(() => { console.error("⏱ délai global dépassé"); process.exit(2); }, 240000).unref();   // unref : ne retient pas le processus une fois le banc fini

const PORT = 8851;
const base = `http://127.0.0.1:${PORT}`;
const SECRET = { username: "sam@exemple.fr", password: "Tr0p-secret-pour-la-page" };
// Mot de passe à BLANCS (deux espaces, tabulation) : le site le répète dans son message d'erreur après avoir
// normalisé les blancs — le masque doit quand même le reconnaître.
const SECRET_BLANCS = { username: "sam@exemple.fr", password: "Tr0p  secret\tavec blancs" };
const FORM_FIELDS = '<input id="username" name="username" autocomplete="username"><input id="password" name="password" type="password"><button type="submit">Se connecter</button>';

const srv = http.createServer((q, r) => {
  const u = q.url.split("?")[0];
  if (u === "/favicon.ico") { r.writeHead(404); return r.end(); }
  r.setHeader("content-type", "text/html; charset=utf-8");
  // 1. Le site refuse le mot de passe : message dans un [role=alert] du formulaire, qui RÉPÈTE le mot de
  //    passe et l'identifiant tapés (le pire cas : errorText ne doit jamais les laisser passer).
  if (u === "/mauvais") return r.end(`<h1>Connexion</h1><form id="f">${FORM_FIELDS}<div id="err"></div></form>
    <script>f.addEventListener("submit", e => { e.preventDefault(); err.setAttribute("role", "alert");
      err.textContent = "Mot de passe « " + password.value + " » incorrect pour " + username.value + ". Réessayez."; });</script>`);
  // 2. Un reCAPTCHA (iframe servie d'ici, src contenant « recaptcha ») bloque la soumission.
  if (u === "/captcha") return r.end(`<h1>Connexion</h1><form id="f">${FORM_FIELDS}</form>
    <iframe src="/recaptcha/api2/bframe?k=abc" title="défi reCAPTCHA" width="400" height="580"></iframe>
    <script>f.addEventListener("submit", e => e.preventDefault());</script>`);
  if (u === "/recaptcha/anchor") return r.end('<label><input type="checkbox"> Je ne suis pas un robot</label>');
  if (u === "/recaptcha/api2/bframe") return r.end('<p>Sélectionnez toutes les images contenant un feu de signalisation.</p>');
  if (u === "/recaptcha/api2/anchor") return r.end('<span>badge</span>');
  // 1b. Même refus, mot de passe à blancs répété par le site : le [role=alert] a normalisé les blancs (HTML).
  if (u === "/mauvais-blancs") return r.end(`<h1>Connexion</h1><form id="f">${FORM_FIELDS}<div id="err"></div></form>
    <script>f.addEventListener("submit", e => { e.preventDefault(); err.setAttribute("role", "alert");
      err.textContent = "Mot de passe « " + password.value + " » incorrect. Réessayez."; });</script>`);
  // 2c. Site qui utilise reCAPTCHA v3 : la page d'ARRIVÉE porte le badge invisible (iframe api2/anchor
  //     size=invisible, 256×60, dans .grecaptcha-badge en visibility:hidden) — ce n'est PAS un captcha.
  if (u === "/badge-v3") return r.end(`<h1>Connexion</h1><form method="get" action="/dashboard-badge">${FORM_FIELDS}</form>
    <p>Ce site est protégé par reCAPTCHA et les règles de confidentialité de Google s'appliquent.</p>`);
  if (u === "/dashboard-badge") return r.end(`<h1>Tableau de bord</h1><p>Vous êtes connecté.</p><a href="/logout">Déconnexion</a>
    <div class="grecaptcha-badge" style="width:256px;height:60px;position:fixed;bottom:14px;right:-186px;visibility:hidden"><iframe src="/recaptcha/api2/anchor?ar=1&k=abc&size=invisible" width="256" height="60" title="reCAPTCHA"></iframe></div>`);
  // 2d. Le mot « challenge » dans un tableau de la page d'arrivée (tableau de bord Cloudflare) : pas un captcha.
  if (u === "/challenge-mot") return r.end(`<h1>Connexion</h1><form method="get" action="/dashboard-tableau">${FORM_FIELDS}</form>`);
  if (u === "/dashboard-tableau") return r.end('<h1>Sécurité</h1><table><tr><th>Règle</th><th>Action</th></tr><tr><td>Bots</td><td>Managed Challenge</td></tr><tr><td>Pays</td><td>Block</td></tr></table><a href="/logout">Déconnexion</a>');
  // 2e. successUrl déclaré, mais après le mot de passe le site interpose un DÉFI (page sans mot de passe, iframe
  //     bframe visible) : c'est un captcha, pas « arrivé ailleurs / mauvais compte ».
  if (u === "/interstitiel") return r.end(`<h1>Connexion</h1><form method="get" action="/verif-humain">${FORM_FIELDS}</form>`);
  if (u === "/verif-humain") return r.end('<h1>Vérification</h1><iframe src="/recaptcha/api2/bframe?k=abc" width="400" height="580" title="défi"></iframe>');
  // 7. Deux étapes vers une impasse : après l'identifiant, page sans champ, sans code, sans session, sans captcha.
  if (u === "/impasse") return r.end('<h1>Connexion</h1><form method="post" action="/step1-impasse"><input id="username" name="username" autocomplete="username"><button type="submit">Continuer</button></form>');
  //    (adresse sous /auth/ : une page d'authentification ne vaut jamais « page interne connectée » pour looksSignedIn)
  if (u === "/step1-impasse") { r.writeHead(302, { location: "/auth/patientez" }); return r.end(); }
  if (u === "/auth/patientez") return r.end('<h1>Patientez</h1><p>Votre demande est en cours de traitement.</p>');
  // 2b. Vérification humaine annoncée par le texte seul (pas d'iframe).
  if (u === "/captcha-texte") return r.end(`<h1>Connexion</h1><p>Veuillez vérifier que vous êtes bien humain avant de continuer.</p><form id="f">${FORM_FIELDS}</form>
    <script>f.addEventListener("submit", e => e.preventDefault());</script>`);
  // 3. Le formulaire ne bouge pas : ni message, ni captcha, le champ mot de passe reste là.
  if (u === "/inchange") return r.end(`<h1>Connexion</h1><form id="f">${FORM_FIELDS}</form>
    <script>f.addEventListener("submit", e => e.preventDefault());</script>`);
  // 4. Deux étapes : après l'identifiant, le site ouvre la session sans jamais demander de mot de passe
  //    (Expedia avec une identité vivante) — POST /step1 redirige droit sur le tableau de bord.
  if (u === "/deux-etapes") return r.end('<h1>Connexion</h1><form method="post" action="/step1"><input id="username" name="username" autocomplete="username"><button type="submit">Continuer</button></form>');
  if (u === "/step1") { r.writeHead(302, { location: "/dashboard" }); return r.end(); }
  if (u === "/dashboard") return r.end('<h1>Tableau de bord</h1><p>Vous êtes connecté.</p><a href="/logout">Déconnexion</a>');
  r.end("<p>accueil</p>");
});
await new Promise(r => srv.listen(PORT, "127.0.0.1", r));

const cfg = await import("../src/config.js");
const kc = await import("../src/keychain.js");
const { connect, allPages, stopLaunchedChrome, detectCaptcha } = await import("../src/browser.js");
const { login, waitCode } = await import("../src/login.js");
const outcomes = await import("../src/outcomes.js");

// Un site par cas (même domaine : l'onglet unique est ramené sur about:blank entre deux cas, voir resetTab).
const SITES = { mauvais: "/mauvais", "mauvais-blancs": "/mauvais-blancs", captcha: "/captcha", "captcha-texte": "/captcha-texte", inchange: "/inchange", "deux-etapes": "/deux-etapes",
  "badge-v3": "/badge-v3", "challenge-mot": "/challenge-mot", interstitiel: "/interstitiel", impasse: "/impasse" };
const siteDef = (k, p) => ({ domain: "127.0.0.1", loginUrl: base + p, policy: "always", selectors: {}, ...(k === "interstitiel" ? { successUrl: "/dashboard" } : {}) });
cfg.saveSites(Object.fromEntries(Object.entries(SITES).map(([k, p]) => [k, siteDef(k, p)])));
for (const k of Object.keys(SITES)) kc.setSecret(k, k === "mauvais-blancs" ? SECRET_BLANCS : SECRET);

// Espion : le secret est lu par ici, jamais par le Trousseau pendant le remplissage.
let secretReads = 0;
const readSecret = key => { secretReads++; return { ...(key === "mauvais-blancs" ? SECRET_BLANCS : SECRET) }; };

/** Ramène l'onglet du site (unique, partagé par tous les cas : même domaine) sur about:blank. */
async function resetTab() {
  const b = await connect();
  for (const p of allPages(b)) if (!p.isClosed() && p.url().startsWith(base)) await p.goto("about:blank").catch(() => {});
  await b.close();
}

/** Table des codes de la spécification (§1) : outcome, retry, actor. */
const TABLE = {
  "ok.signed_in": ["ok", "never", "none"], "ok.already_signed_in": ["ok", "never", "none"], "ok.signed_in_after_step1": ["ok", "never", "none"],
  "ok.via_provider": ["ok", "never", "none"], "ok.code_accepted": ["ok", "never", "none"], "ok.no_code_pending": ["ok", "never", "none"], "ok.probed": ["ok", "never", "none"],
  "pending.second_factor_no_field": ["pending", "now", "user"], "pending.user_approval": ["pending", "now", "user"],
  "fail.password_rejected": ["fail", "never", "admin"], "fail.captcha": ["fail", "human", "user"], "fail.form_unchanged": ["fail", "later", "none"],
  "fail.no_password_step": ["fail", "later", "admin"], "fail.no_form": ["fail", "later", "admin"], "fail.code_rejected": ["fail", "now", "user"],
  "fail.form_still_visible": ["fail", "now", "none"], "fail.landed_elsewhere": ["fail", "never", "user"], "fail.wrong_account": ["fail", "never", "user"],
  "fail.provider_needed": ["fail", "never", "admin"], "fail.provider_intervention": ["fail", "human", "user"], "fail.domain_approval": ["fail", "human", "user"],
  "fail.tab_left": ["fail", "later", "none"], "fail.rate_limited": ["fail", "later", "none"], "fail.locked": ["fail", "never", "user"], "fail.revoked": ["fail", "never", "user"],
  "fail.access_refused": ["fail", "never", "user"], "fail.no_secret": ["fail", "never", "admin"], "fail.unknown_site": ["fail", "never", "admin"],
  "fail.keychain_waiting": ["fail", "later", "user"], "fail.browser": ["fail", "later", "admin"], "fail.extension": ["fail", "later", "admin"],
  "fail.uncertain": ["fail", "human", "user"], "fail.unexpected": ["fail", "later", "admin"],
};
const RETRY = ["now", "later", "never", "human"], ACTOR = ["none", "user", "sesame", "admin"], OUTCOME = ["ok", "pending", "fail"];

/** Tout résultat de login()/waitCode() porte les quatre champs, cohérents entre eux et avec `ok`. */
function checkShape(r, label) {
  assert.ok(OUTCOME.includes(r.outcome), `${label} : outcome manquant ou inconnu (${r.outcome})`);
  assert.equal(typeof r.code, "string", `${label} : code manquant`);
  assert.ok(r.code.startsWith(r.outcome + "."), `${label} : code « ${r.code} » incohérent avec outcome « ${r.outcome} »`);
  assert.ok(RETRY.includes(r.retry), `${label} : retry manquant ou inconnu (${r.retry})`);
  assert.ok(ACTOR.includes(r.actor), `${label} : actor manquant ou inconnu (${r.actor})`);
  assert.equal(r.ok, r.outcome === "ok", `${label} : ok=${r.ok} mais outcome=${r.outcome}`);
  if (r.retry === "human") assert.equal(typeof r.human, "string", `${label} : retry « human » sans chemin humain (human)`);
  if (r.confidence !== undefined) assert.ok(["high", "medium", "low"].includes(r.confidence), `${label} : confidence inconnue (${r.confidence})`);
  if (r.outcome !== "ok") assert.equal(r.confidence, undefined, `${label} : confidence réservée aux succès`);
  // Les codes dont la spécification fixe la confiance (§1) doivent la porter.
  if (["ok.signed_in", "ok.already_signed_in", "ok.no_code_pending"].includes(r.code)) assert.ok(r.confidence, `${label} : confidence manquante pour ${r.code}`);
  const row = TABLE[r.code];
  if (row) { assert.equal(r.retry, row[1], `${label} : retry de ${r.code}`); assert.equal(r.actor, row[2], `${label} : actor de ${r.code}`); }
  assert.ok(!JSON.stringify(r).includes(SECRET.password), `${label} : le mot de passe apparaît dans la réponse`);
  const collapsed = SECRET_BLANCS.password.replace(/\s+/g, " ");
  assert.ok(!JSON.stringify(r).replace(/\s+/g, " ").includes(collapsed), `${label} : le mot de passe à blancs apparaît dans la réponse`);
}

const results = [];
let failed = null;
try {
  // 0. Le module outcomes.js : la table, outcome() et withOutcome().
  {
    for (const [code, [o, retry, actor]] of Object.entries(TABLE)) {
      const x = outcomes.outcome(code);
      assert.deepEqual([x.outcome, x.code, x.retry, x.actor], [o, code, retry, actor], `outcome(${code})`);
    }
    const sf = outcomes.outcome("pending.second_factor");
    assert.equal(sf.outcome, "pending"); assert.equal(sf.retry, "now"); assert.ok(["user", "sesame"].includes(sf.actor), `pending.second_factor : actor ${sf.actor}`);
    const extra = outcomes.outcome("fail.rate_limited", { retryAfter: "2026-11-09T08:30:00.000Z" });
    assert.equal(extra.retryAfter, "2026-11-09T08:30:00.000Z", "outcome() garde les champs supplémentaires");
    const merged = outcomes.withOutcome({ ok: false, message: "m", steps: ["a"] }, "fail.captcha", { human: "ouvre la page" });
    assert.equal(merged.ok, false); assert.equal(merged.message, "m"); assert.deepEqual(merged.steps, ["a"]);
    assert.equal(merged.code, "fail.captcha"); assert.equal(merged.outcome, "fail"); assert.equal(merged.retry, "human"); assert.equal(merged.actor, "user"); assert.equal(merged.human, "ouvre la page");
    console.log(`  0 outcomes.js : ${Object.keys(TABLE).length} codes de la table vérifiés, outcome() et withOutcome() conformes`);
  }

  // 1. Mot de passe refusé : fail.password_rejected, errorText lisible mais SANS le mot de passe ni l'identifiant.
  {
    const r = await login({ site: "mauvais", caller: "test", waitForCode: false, readSecret });
    results.push([r, "mauvais"]);
    assert.equal(r.ok, false, `un mot de passe refusé n'est pas un succès : ${r.message}`);
    assert.equal(r.code, "fail.password_rejected", `code : ${r.code} (${r.message})`);
    assert.equal(r.retry, "never"); assert.equal(r.actor, "admin");
    assert.equal(typeof r.errorText, "string", "errorText attendu");
    assert.match(r.errorText, /incorrect/i, `errorText : ${r.errorText}`);
    assert.ok(!r.errorText.includes(SECRET.password), `errorText contient le mot de passe : ${r.errorText}`);
    assert.ok(!r.errorText.includes(SECRET.username), `errorText contient l'identifiant : ${r.errorText}`);
    assert.ok(r.errorText.length <= 120, `errorText trop long (${r.errorText.length})`);
    assert.ok(!(r.message || "").includes(SECRET.password), "le message ne doit pas contenir le mot de passe");
    const pw = await (async () => { const b = await connect(); const p = allPages(b).find(p => p.url().startsWith(base)); const v = p ? await p.evaluate(() => document.querySelector("#password")?.value ?? null) : null; await b.close(); return v; })();
    assert.equal(pw, "", "le champ mot de passe doit avoir été vidé après le refus");
    console.log(`  1 « mot de passe incorrect » dans [role=alert] → fail.password_rejected, errorText masqué (« ${r.errorText} »)`);
  }

  // 1b. Mot de passe à blancs (deux espaces, tabulation) répété par le site, blancs normalisés par le HTML :
  //     le masque le reconnaît quand même — jamais « Tr0p secret avec blancs » dans errorText.
  await resetTab();
  {
    const r = await login({ site: "mauvais-blancs", caller: "test", waitForCode: false, readSecret });
    results.push([r, "mauvais-blancs"]);
    assert.equal(r.code, "fail.password_rejected", `code : ${r.code} (${r.message})`);
    assert.equal(typeof r.errorText, "string", "errorText attendu");
    const collapsed = SECRET_BLANCS.password.replace(/\s+/g, " ");
    assert.ok(!r.errorText.replace(/\s+/g, " ").includes(collapsed), `errorText laisse passer le mot de passe à blancs : ${r.errorText}`);
    assert.ok(!r.errorText.includes("secret"), `errorText laisse passer un morceau du mot de passe : ${r.errorText}`);
    assert.match(r.errorText, /masqué/, `errorText : ${r.errorText}`);
    console.log(`  1b mot de passe à blancs répété par le site → masqué malgré la normalisation des blancs (« ${r.errorText} »)`);
  }

  // 2. reCAPTCHA : fail.captcha, retry human (chemin humain fourni), actor user.
  await resetTab();
  {
    const r = await login({ site: "captcha", caller: "test", waitForCode: false, readSecret });
    results.push([r, "captcha"]);
    assert.equal(r.ok, false, `un captcha n'est pas un succès : ${r.message}`);
    assert.equal(r.code, "fail.captcha", `code : ${r.code} (${r.message})`);
    assert.equal(r.retry, "human"); assert.equal(r.actor, "user");
    assert.equal(typeof r.human, "string", "retry « human » doit s'accompagner du chemin humain");
    console.log("  2 iframe « recaptcha » après soumission → fail.captcha, retry human");
  }
  await resetTab();
  {
    const r = await login({ site: "captcha-texte", caller: "test", waitForCode: false, readSecret });
    results.push([r, "captcha-texte"]);
    assert.equal(r.code, "fail.captcha", `code : ${r.code} (${r.message})`);
    console.log("  2b « vérifier que vous êtes bien humain » (texte seul) → fail.captcha");
  }
  // 2c. Badge reCAPTCHA v3 (ancre invisible) sur la page d'arrivée : connexion réussie, pas un captcha.
  await resetTab();
  {
    const r = await login({ site: "badge-v3", caller: "test", waitForCode: false, readSecret });
    results.push([r, "badge-v3"]);
    assert.equal(r.ok, true, `le badge reCAPTCHA v3 n'est pas un captcha : ${r.code} — ${r.message}`);
    assert.equal(r.code, "ok.signed_in", `code : ${r.code}`);
    assert.match(r.url || "", /\/dashboard-badge$/, `url : ${r.url}`);
    const seen = await (async () => { const b = await connect(); const p = allPages(b).find(p => p.url().startsWith(base)); const v = p ? await detectCaptcha(p) : null; await b.close(); return v; })();
    assert.equal(seen, false, "detectCaptcha doit ignorer le badge v3 (api2/anchor, size=invisible, .grecaptcha-badge, visibility:hidden)");
    console.log("  2c badge reCAPTCHA v3 sur la page d'arrivée → ok.signed_in (detectCaptcha : false)");
  }
  // 2d. Le mot « challenge » dans un tableau de la page d'arrivée : pas un captcha.
  await resetTab();
  {
    const r = await login({ site: "challenge-mot", caller: "test", waitForCode: false, readSecret });
    results.push([r, "challenge-mot"]);
    assert.equal(r.ok, true, `le mot « challenge » dans un tableau n'est pas un captcha : ${r.code} — ${r.message}`);
    assert.equal(r.code, "ok.signed_in", `code : ${r.code}`);
    console.log("  2d « Managed Challenge » dans un tableau → ok.signed_in, pas de captcha");
  }
  // 2e. successUrl déclaré, défi interposé après le mot de passe : fail.captcha (chemin humain), pas
  //     fail.landed_elsewhere (« mauvais compte »).
  await resetTab();
  {
    const r = await login({ site: "interstitiel", caller: "test", waitForCode: false, readSecret });
    results.push([r, "interstitiel"]);
    assert.equal(r.ok, false);
    assert.equal(r.code, "fail.captcha", `un défi après soumission prime sur successUrl : ${r.code} (${r.message})`);
    assert.equal(r.retry, "human"); assert.equal(typeof r.human, "string");
    console.log("  2e successUrl manqué À CAUSE d'un défi → fail.captcha (pas « arrivé ailleurs »)");
  }

  // 3. Formulaire inchangé : ni message, ni captcha → fail.form_unchanged, retry later.
  await resetTab();
  {
    const r = await login({ site: "inchange", caller: "test", waitForCode: false, readSecret });
    results.push([r, "inchange"]);
    assert.equal(r.ok, false, `un formulaire inchangé n'est pas un succès : ${r.message}`);
    assert.equal(r.code, "fail.form_unchanged", `code : ${r.code} (${r.message})`);
    assert.equal(r.retry, "later"); assert.equal(r.actor, "none");
    assert.equal(r.errorText, undefined, "pas d'errorText sans message d'erreur");
    console.log("  3 champ mot de passe encore là, sans message ni captcha → fail.form_unchanged");
  }

  // 5. waitCode sur l'onglet qui montre encore le formulaire identifiant/mot de passe : aucun code n'est
  //    attendu, la réponse le dit (fail.form_still_visible) au lieu d'un faux « aucun code demandé » ok.
  {
    const r = await waitCode({ site: "inchange", timeoutSec: 10, caller: "test" });
    results.push([r, "waitCode"]);
    assert.equal(r.ok, false, `un formulaire affiché n'est pas « aucun code demandé » : ${r.message}`);
    assert.equal(r.code, "fail.form_still_visible", `code : ${r.code} (${r.message})`);
    assert.equal(r.retry, "now"); assert.equal(r.actor, "none");
    console.log("  5 waitCode sur un formulaire → fail.form_still_visible (appeler sesame_login)");
  }

  // 4. Deux étapes, session ouverte dès l'identifiant : succès ok.signed_in_after_step1, pas un échec « le mot
  //    de passe n'est pas apparu ».
  await resetTab();
  {
    const r = await login({ site: "deux-etapes", caller: "test", waitForCode: false, readSecret });
    results.push([r, "deux-etapes"]);
    assert.equal(r.ok, true, `connexion ouverte dès l'identifiant : ${r.message}`);
    assert.equal(r.code, "ok.signed_in_after_step1", `code : ${r.code} (${r.message})`);
    assert.equal(r.retry, "never"); assert.equal(r.actor, "none");
    assert.match(r.url || "", /\/dashboard$/, `url d'arrivée : ${r.url}`);
    assert.ok((r.steps || []).some(s => /étape 1/.test(s)), `étapes : ${JSON.stringify(r.steps)}`);
    console.log("  4 deux étapes, POST /step1 → tableau de bord → ok.signed_in_after_step1");
  }

  // 7. Deux étapes vers une impasse (page sans champ, sans code, sans session, sans captcha) : fail.no_password_step
  //    rendu SANS attendre le réattachement du champ identifiant disparu (Locator.evaluate : 30 s) — l'attente
  //    normale est ~10 s (mot de passe) + 6 s (code) ; on tolère 30 s en tout.
  await resetTab();
  {
    const t0 = Date.now();
    const r = await login({ site: "impasse", caller: "test", waitForCode: false, readSecret });
    const sec = Math.round((Date.now() - t0) / 1000);
    results.push([r, "impasse"]);
    assert.equal(r.ok, false);
    assert.equal(r.code, "fail.no_password_step", `code : ${r.code} (${r.message})`);
    assert.ok(sec < 30, `fail.no_password_step a mis ${sec} s (readFormError attend le champ disparu ?)`);
    console.log(`  7 deux étapes vers une impasse → fail.no_password_step en ${sec} s (champ disparu : pas d'attente de 30 s)`);
  }

  // 6. Tout résultat porte outcome, code, retry, actor — cohérents avec la table et avec `ok`.
  for (const [r, label] of results) checkShape(r, label);
  assert.equal(secretReads, 10, `le secret doit avoir été lu une fois par connexion (${secretReads})`);
  console.log(`  6 ${results.length} réponses : outcome, code, retry, actor présents et cohérents ; jamais le mot de passe`);
} catch (e) {
  failed = e;
} finally {
  for (const k of Object.keys(SITES)) { try { kc.deleteSecret(k); } catch {} }
  await stopLaunchedChrome();   // attendu : le filet « exit » n'est qu'un secours (bancs d'essai)
  srv.closeAllConnections?.(); srv.close();
  await new Promise(r => setTimeout(r, 1200));
  fs.rmSync(HOME, { recursive: true, force: true });
}
if (failed) { console.error("❌ outcomes :", failed.message); process.exit(1); }
console.log("✅ outcomes OK — chaque réponse dit exactement ce qui s'est passé (code, retry, actor), sans jamais le secret");
