// Connexion par fournisseur d'identité : Sésame clique le bouton, ne tape jamais rien chez le fournisseur,
// et un mot de passe refusé répond ÉCHEC (et non « ok » assorti d'un indice).
// Chromium headless + pages locales : aucune vraie connexion, ni Google, ni Chrome Sésame.
import http from "node:http"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import assert from "node:assert/strict";
process.env.SESAME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-sso-"));
process.env.SESAME_KEYCHAIN_SERVICE = "sesame-sso-" + process.pid;   // aucun élément ne doit exister : un site fournisseur n'en a pas
process.env.SESAME_CDP_URL = "http://127.0.0.1:9237";                  // Chrome de test (profil temporaire) pour login()
process.env.SESAME_CHROME_HEADLESS = "1";
const PORT = 8847;
let sessionOuverte = true;   // la session du fournisseur vit déjà dans le navigateur
let choisi = null;           // quelle tuile du faux sélecteur de comptes a reçu un clic
let consentCliques = 0;      // combien de fois le bouton « Continuer » du faux consentement a été cliqué

const srv = http.createServer((q, r) => {
  const u = q.url.split("?")[0];
  r.setHeader("content-type", "text/html; charset=utf-8");
  if (u === "/dashboard") { if (q.url.includes("as=")) choisi = decodeURIComponent(q.url.split("as=")[1]); return r.end('<h1>Tableau de bord</h1><a href="/logout">Deconnexion</a>'); }
  if (u === "/consent-click") { consentCliques++; return r.end("ok"); }
  if (u === "/google-login") return r.end('<h1>Mon site</h1><a href="https://accounts.google.com/signin/chooser">Se connecter avec Google</a>');
  // Vitrine publique : le site renvoie sa page de connexion vers une page « interne » SANS formulaire ni déconnexion
  // (Indeed : employers.indeed.com → fr.indeed.com/recrutement/cs). Ce n'est PAS une session ouverte.
  if (u === "/vitrine-login") { r.writeHead(302, { location: "/recrutement/cs" }); return r.end(); }
  if (u === "/recrutement/cs") return r.end('<h1>Publier une offre</h1><a href="/auth">Se connecter</a><a href="/creer">Créer un compte employeur</a>');
  if (u === "/auth") return r.end('<h1>Connexion</h1><a href="https://accounts.google.com/signin/chooser">Continuer avec Google</a>');
  if (u === "/idp") {   // le « fournisseur » : s'il a une session, il renvoie au site ; sinon il demande
    if (sessionOuverte) { r.writeHead(302, { location: "/dashboard" }); return r.end(); }
    return r.end('<h1>Connexion Google</h1><input name="email" id="email"><input type="password" id="password"><button>Suivant</button>');
  }
  if (u === "/sso")       return r.end('<p>This account uses single sign-on (SSO).</p><input type="password" id="password"><button type="submit">Se connecter</button>');
  return r.end('<a href="/idp">Se connecter avec Google</a><form action="/sso"><input id="username"><input type="password" id="password"><button type="submit">Se connecter</button></form>');
});
await new Promise(r => srv.listen(PORT, "127.0.0.1", r));

const { chromium } = await import("playwright-core");
const { fillLogin } = await import("../src/browser.js");
const base = `http://127.0.0.1:${PORT}`;
const site = k => ({ key: k, domain: "127.0.0.1", loginUrl: `${base}/`, selectors: {} });
const secret = { username: "u", password: "p" };
const b = await chromium.launch({ headless: true });
let failed = null;
try {
  // 1. Site déclaré « par Google », session du fournisseur ouverte : un clic suffit, rien n'est tapé.
  {
    const p = await b.newPage(); await p.goto(`${base}/`);
    const s = { ...site("demo"), authProvider: "google" };
    const r = await fillLogin(p, s, { ...secret }, { waitSecondFactor: false });
    assert.equal(r.ok, true, `attendu un succes : ${r.reason}`);
    assert.equal(r.viaProvider, "google");
    assert.ok(r.steps.some(x => /Google.*cliqu/i.test(x)), `etapes : ${JSON.stringify(r.steps)}`);
    await p.close();
    console.log("  1 bouton Google cliqué, session du fournisseur acceptée → succès viaProvider");
  }
  // 2. Même site, mais le fournisseur demande quelque chose : ÉCHEC clair, et RIEN n'est saisi chez lui.
  {
    sessionOuverte = false;
    const p = await b.newPage(); await p.goto(`${base}/`);
    const s = { ...site("demo"), authProvider: "google" };
    const r = await fillLogin(p, s, { ...secret }, { waitSecondFactor: false });
    assert.equal(r.ok, false, "le fournisseur demande une intervention : ce n'est pas un succes");
    assert.equal(r.needsProvider, "google");
    const vals = await p.evaluate(() => [...document.querySelectorAll("input")].map(e => e.value));
    assert.deepEqual(vals, ["", ""], `Sesame ne doit RIEN taper chez le fournisseur : ${JSON.stringify(vals)}`);
    await p.close();
    sessionOuverte = true;
    console.log("  2 fournisseur qui demande un compte → échec explicite, aucun champ rempli chez lui");
  }
  // 3. Compte en authentification unique, mot de passe tenté : ÉCHEC qui nomme la cause, plus jamais « ok ».
  {
    const p = await b.newPage(); await p.goto(`${base}/sso`);
    const r = await fillLogin(p, site("demo"), { ...secret }, { waitSecondFactor: false });
    assert.equal(r.ok, false, "un mot de passe refuse ne doit plus repondre ok");
    assert.match(r.reason, /authentification unique|single sign|fournisseur/i, `motif : ${r.reason}`);
    await p.close();
    console.log("  3 « single sign-on » détecté → échec qui nomme la cause (et non un succès avec indice)");
  }

  // --- Choix du compte chez le fournisseur : par CLIC seulement. Le fournisseur est simulé par une route
  // Playwright sur accounts.google.com (hôte réel, mais aucune requête ne sort : la page est servie d'ici).
  const tile = (email, nom) => `<li data-email="${email}"><div role="link" tabindex="0" data-identifier="${email}" onclick="location.href='${base}/dashboard?as='+encodeURIComponent('${email}')"><b>${nom}</b><br>${email}</div></li>`;
  const CHOOSER = `<h1>Choisir un compte</h1><ul>${tile("autre@example.com", "Autre")}${tile("sampwieder@gmail.com", "Sam")}</ul><input id="identifierId" name="identifier"><input type="password" name="Passwd">`;
  const CONSENT = `<h1>Indeed souhaite accéder à votre compte Google</h1><p>Cette application pourra voir votre adresse e-mail.</p><input id="identifierId"><button onclick="new Image().src='${base}/consent-click'">Continuer</button><button>Annuler</button>`;
  let ecran = CHOOSER;
  const googleCtx = async () => {
    const ctx = await b.newContext();
    await ctx.route("https://accounts.google.com/**", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: ecran }));
    return ctx;
  };
  const providerSite = extra => ({ ...site("indeed"), loginUrl: `${base}/google-login`, authProvider: "google", ...extra });

  // 4. Faux sélecteur de comptes à deux tuiles : seule la tuile du compte déclaré est cliquée (casse ignorée), rien n'est tapé.
  {
    ecran = CHOOSER; choisi = null;
    const ctx = await googleCtx(); const p = await ctx.newPage(); await p.goto(`${base}/google-login`);
    const logged = [];
    const r = await fillLogin(p, providerSite({ account: "SampWieder@Gmail.com" }), { username: "SampWieder@Gmail.com", password: "" }, { waitSecondFactor: false, onStep: d => logged.push(d.detail) });
    assert.equal(r.ok, true, `attendu un succès : ${r.reason}`);
    assert.equal(r.viaProvider, "google");
    assert.equal(choisi, "sampwieder@gmail.com", `mauvaise tuile cliquée : ${choisi}`);
    assert.ok(r.steps.some(x => /sampwieder@gmail\.com.*choisi|choisi.*sampwieder@gmail\.com/i.test(x)), `étapes : ${JSON.stringify(r.steps)}`);
    assert.deepEqual(logged, r.steps.filter(x => !/cookies/.test(x)), "chaque étape doit aussi partir au journal");
    await ctx.close();
    console.log("  4 sélecteur à deux tuiles → seule la tuile du compte déclaré est cliquée, connecté");
  }
  // 5. Compte déclaré absent des tuiles, ou aucun compte déclaré avec plusieurs tuiles : aucun clic, motif qui nomme la cause.
  for (const [account, motif] of [["inconnu@example.com", /inconnu@example\.com/], [undefined, /aucun compte.*déclaré/i]]) {
    ecran = CHOOSER; choisi = null;
    const ctx = await googleCtx(); const p = await ctx.newPage(); await p.goto(`${base}/google-login`);
    const r = await fillLogin(p, providerSite({ account }), { username: account || "", password: "" }, { waitSecondFactor: false });
    assert.equal(r.ok, false);
    assert.equal(r.needsProvider, "google");
    assert.match(r.reason, motif, `motif : ${r.reason}`);
    assert.equal(choisi, null, "aucune tuile ne doit être cliquée");
    assert.equal(p.url().startsWith("https://accounts.google.com"), true, "la page reste chez le fournisseur");
    assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll("input")].map(e => e.value)), ["", ""], "aucun champ rempli");
    await ctx.close();
  }
  console.log("  5 compte absent des tuiles / non déclaré avec plusieurs comptes → needsProvider, aucun clic, aucun champ rempli");
  // 6. Écran de consentement : Sésame s'arrête, ne clique pas « Continuer ».
  {
    ecran = CONSENT; consentCliques = 0;
    const ctx = await googleCtx(); const p = await ctx.newPage(); await p.goto(`${base}/google-login`);
    const r = await fillLogin(p, providerSite({ account: "sampwieder@gmail.com" }), { username: "sampwieder@gmail.com", password: "" }, { waitSecondFactor: false });
    assert.equal(r.ok, false);
    assert.equal(r.needsProvider, "google");
    assert.match(r.reason, /consentement à donner une fois par Sam/);
    assert.equal(consentCliques, 0, "le consentement ne doit jamais être cliqué");
    assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll("input")].map(e => e.value)), [""], "aucun champ rempli");
    await ctx.close();
    console.log("  6 écran de consentement → arrêt « consentement à donner une fois par Sam », bouton non cliqué");
  }

  // 4b. Vitrine publique (redirection hors page de connexion, ni formulaire ni déconnexion) : jamais « déjà connecté ».
  {
    ecran = CHOOSER; choisi = null;
    const ctx = await googleCtx(); const p = await ctx.newPage(); await p.goto(`${base}/vitrine-login`);
    const logged = [];
    const r = await fillLogin(p, providerSite({ loginUrl: `${base}/vitrine-login`, account: "sampwieder@gmail.com" }), { username: "sampwieder@gmail.com", password: "" }, { waitSecondFactor: false, onStep: d => logged.push(d.detail) });
    assert.equal(r.ok, true, `attendu un succès : ${r.reason}`);
    assert.equal(r.alreadySignedIn, undefined, "une vitrine publique n'est pas une session ouverte");
    assert.equal(r.viaProvider, "google");
    assert.equal(choisi, "sampwieder@gmail.com");
    assert.ok(r.steps.some(x => /entrée « se connecter »/.test(x)), `étapes : ${JSON.stringify(r.steps)}`);
    await ctx.close();
    console.log("  4b vitrine publique → entrée « Se connecter » cliquée, bouton Google, tuile du bon compte (pas de faux « déjà connecté »)");
  }
  // 4c. Vraie session ouverte (tableau de bord, déconnexion visible, aucune entrée « Se connecter ») : toujours « déjà connecté ».
  {
    const ctx = await googleCtx(); const p = await ctx.newPage(); await p.goto(`${base}/dashboard`);
    const r = await fillLogin(p, providerSite({ loginUrl: `${base}/dashboard` }), { username: "", password: "" }, { waitSecondFactor: false });
    assert.equal(r.ok, true, `attendu un succès : ${r.reason}`);
    assert.equal(r.alreadySignedIn, true);
    await ctx.close();
    console.log("  4c tableau de bord avec déconnexion → « déjà connecté » conservé");
  }

  // --- Par login() : site fournisseur SANS entrée Trousseau, jamais de lecture du secret, jamais par l'extension.
  {
    const cfg = await import("../src/config.js");
    const kc = await import("../src/keychain.js");
    const { login, requestSite, requestStatus } = await import("../src/login.js");
    const { stopLaunchedChrome } = await import("../src/browser.js");
    cfg.saveSites({ indeed: { domain: "127.0.0.1", loginUrl: `${base}/`, policy: "always", authProvider: "google", account: "sampwieder@gmail.com", selectors: {} } });
    assert.equal(kc.hasSecret("indeed"), false, "précondition : aucune entrée Trousseau");
    const readSecret = () => { throw new Error("le Trousseau ne doit JAMAIS être lu pour un site fournisseur"); };
    sessionOuverte = true;
    const r = await login({ site: "indeed", caller: "test", waitForCode: false, readSecret });
    assert.equal(r.ok, true, `login : ${r.message}`);
    assert.equal(r.viaProvider, "google");
    assert.notEqual(r.channel, "extension");
    const { readJournal } = await import("../src/journal.js");
    const j = readJournal({ site: "indeed", limit: 50 });
    assert.ok(j.some(e => e.action === "provider" && /Google.*cliqu/i.test(e.detail || "")), "les étapes fournisseur doivent figurer au journal");
    assert.ok(!j.some(e => /lecture du Trousseau|identifiants lus/.test(e.detail || "")), "aucune lecture du Trousseau dans le journal");
    console.log("  7 login() d'un site fournisseur sans Trousseau → succès viaProvider, secret jamais lu, journal complet");

    // Jamais par l'extension, même demandée explicitement : refus net, avant tout envoi.
    process.env.SESAME_BROWSER = "extension";
    const x = await login({ site: "indeed", caller: "test", waitForCode: false, readSecret });
    delete process.env.SESAME_BROWSER;
    assert.equal(x.ok, false);
    assert.match(x.message, /Chrome Sésame/);
    console.log("  8 SESAME_BROWSER=extension → refus propre pour un site fournisseur (rien envoyé à l'extension)");

    // Demande d'enregistrement : authProvider + account vont dans la demande ; « enregistré » sans secret.
    const bad = await requestSite({ site: "x", url: `${base}/`, authProvider: "facebook", caller: "test" });
    assert.equal(bad.ok, false);
    const badAcct = await requestSite({ site: "x", url: `${base}/`, authProvider: "google", account: "pas-un-mail", caller: "test" });
    assert.equal(badAcct.ok, false);
    const ok = await requestSite({ site: "indeed", url: `${base}/`, authProvider: "google", account: "sampwieder@gmail.com", caller: "test" });
    assert.equal(ok.alreadyRegistered, true, "un site fournisseur est « déjà enregistré » sans secret");
    // L'app est « vivante » (bar.alive) : la demande déposée porte authProvider et account, pour que le formulaire s'ouvre en mode fournisseur.
    fs.writeFileSync(path.join(process.env.SESAME_HOME, "bar.alive"), "");
    const dep = await requestSite({ site: "nouveau", url: `${base}/`, authProvider: "github", account: "Sam@Example.com", caller: "test" });
    assert.equal(dep.status, "attente", JSON.stringify(dep));
    const fichier = JSON.parse(fs.readFileSync(path.join(process.env.SESAME_HOME, "requests", dep.requestId + ".json"), "utf8"));
    assert.equal(fichier.authProvider, "github");
    assert.equal(fichier.account, "sam@example.com");
    // L'app répond « saved » après avoir écrit le site dans sites.json (sans Trousseau) : « enregistré ».
    const sites = cfg.loadSites(); sites.nouveau = { domain: "127.0.0.1", loginUrl: `${base}/`, policy: "ask", authProvider: "github", account: "sam@example.com" }; cfg.saveSites(sites);
    fs.writeFileSync(path.join(process.env.SESAME_HOME, "requests", dep.requestId + ".done.json"), JSON.stringify({ status: "saved" }));
    const st = requestStatus({ requestId: dep.requestId, caller: "test" });
    assert.equal(st.status, "enregistré", `requestStatus : ${JSON.stringify(st)}`);
    assert.equal(st.authProvider, "github");
    assert.equal(kc.hasSecret("nouveau"), false);
    console.log("  9 requestSite / requestStatus : un site fournisseur est enregistré sans secret, fournisseur/compte validés");
    await stopLaunchedChrome();
  }
} catch (e) { failed = e; } finally {
  await b.close().catch(() => {});
  srv.close();
  fs.rmSync(process.env.SESAME_HOME, { recursive: true, force: true });
}
if (failed) { console.error("❌ sso :", failed.message); process.exit(1); }
console.log("✅ sso OK — clic du fournisseur, rien tapé chez lui, mot de passe refusé = échec");
