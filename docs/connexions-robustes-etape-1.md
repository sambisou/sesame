# Connexions robustes — étape 1, tranche 1 (spécification, 08/11/2026)

Objectif : **Sésame ne se connecte plus pour rien, et dit exactement ce qui s'est passé.**
Même code sur le Mac (app Sésame) et sur l'atelier (moteur `moteur.mjs` qui importe `src/login.js`,
`src/browser.js`, `src/config.js`, `src/mailbox.js` ; `src/keychain.js` y est remplacé par
`keychain-atelier.js`, mêmes exports). Rien ici ne change la règle de base : **aucun secret, aucun
code à usage unique ne quitte le processus ; l'IA ne reçoit que des verdicts.**

Diagnostic mesuré (journal du Mac, 30 jours, action `login`) : 42 réussites, 39 échecs, dont 24
« mot de passe refusé ou captcha » indistincts, 6 « aucun champ visible », 4 « le mot de passe n'est
pas apparu après l'identifiant » (dont Expedia qui connecte dès l'e-mail : une réussite comptée en échec),
59 « déjà connecté » obtenus après avoir ramené l'onglet sur la page de connexion, lu le secret et parfois
demandé Face ID.

## 1. Codes de résultat lisibles par machine — `src/outcomes.js` (nouveau)

Toute réponse de `login()`, `waitCode()`, `openLogin()` et `probe()` porte désormais, **en plus** des
champs existants (`ok`, `message`, `steps`, `url`, `secondFactor`, `alreadySignedIn`, `viaProvider`,
`needsDomain`, `needsProvider`, `hint`, `status`, `uncertain`, `opened`) :

| champ | valeurs | sens |
|---|---|---|
| `outcome` | `ok` \| `pending` \| `fail` | verdict |
| `code` | voir table | cause précise, stable, en anglais à points |
| `confidence` | `high` \| `medium` \| `low` | solidité du verdict `ok` (absent sinon) |
| `retry` | `now` \| `later` \| `never` \| `human` | ce que l'appelant peut faire |
| `actor` | `none` \| `user` \| `sesame` \| `admin` | qui doit agir (`user` = Sam devant l'écran ; `admin` = réglage à corriger) |
| `retryAfter` | ISO 8601 | seulement avec `fail.rate_limited` |
| `human` | texte court | seulement quand `retry: human` : le chemin humain (quoi faire, où) |

Table des codes (exhaustive pour cette tranche ; en ajouter plutôt que détourner) :

| code | outcome | retry | actor | quand |
|---|---|---|---|---|
| `ok.signed_in` | ok | never | none | formulaire rempli, soumis, site accepté (`confidence` : `high` si `successUrl` vérifié ou `aliveSel` visible ; `medium` si `looksSignedIn` ; `low` si seul le champ mot de passe a disparu) |
| `ok.already_signed_in` | ok | never | none | la sonde (ou `fillLogin`) a trouvé une session vivante ; **aucun secret lu** quand c'est la sonde |
| `ok.signed_in_after_step1` | ok | never | none | connexion en deux étapes : après l'identifiant, le site a ouvert la session sans demander le mot de passe (Expedia, identité vivante) |
| `ok.via_provider` | ok | never | none | bouton du fournisseur cliqué, revenu connecté |
| `ok.code_accepted` | ok | never | none | `waitCode` : le code a été saisi (par Sam ou par Sésame) et accepté |
| `ok.no_code_pending` | ok | never | none | `waitCode` : ni code, ni formulaire ; la page semble connectée (`confidence` selon `looksSignedIn`) |
| `pending.second_factor` | pending | now | user ou sesame | code attendu, délai écoulé ; `actor: sesame` si une boîte mail est configurée (il réessaiera), `user` sinon |
| `pending.second_factor_no_field` | pending | now | user | la page parle d'un code sans champ (choix de méthode, validation sur téléphone) |
| `pending.user_approval` | pending | now | user | réservé à l'atelier (Face ID) ; non émis par ce dépôt, documenté pour cohérence |
| `fail.password_rejected` | fail | never | admin | message d'erreur du site vu après soumission (mot de passe/identifiant refusé, compte verrouillé) |
| `fail.captcha` | fail | human | user | captcha ou vérification humaine détecté (avant ou après soumission) |
| `fail.form_unchanged` | fail | later | none | champ mot de passe encore là après soumission, sans message d'erreur ni captcha |
| `fail.no_password_step` | fail | later | admin | deux étapes : pas de mot de passe, pas de code, pas de session (ancien « le champ mot de passe n'est pas apparu ») |
| `fail.no_form` | fail | later | admin | ni formulaire ni session (ancien « aucun champ identifiant/mot de passe visible ») |
| `fail.code_rejected` | fail | now | user | retour au formulaire mot de passe pendant l'attente du code |
| `fail.form_still_visible` | fail | now | none | `waitCode` : le formulaire identifiant/mot de passe est affiché, aucun code n'est attendu → appeler `sesame_login` |
| `fail.landed_elsewhere` | fail | never | user | `successUrl` non atteint (mauvais compte ou espace) |
| `fail.wrong_account` | fail | never | user | page liée à un autre compte, rien saisi |
| `fail.provider_needed` | fail | never | admin | le site veut un fournisseur d'identité (SSO), déclarer `authProvider` |
| `fail.provider_intervention` | fail | human | user | le fournisseur demande quelque chose, Sésame n'y touche pas |
| `fail.domain_approval` | fail | human | user | `needsDomain` : domaine à autoriser |
| `fail.tab_left` | fail | later | none | onglet parti hors périmètre ou fermé |
| `fail.rate_limited` | fail | later | none | verrou d'essais de Sésame (voir §4) ; `retryAfter` + `human` |
| `fail.locked` | fail | never | user | verrou global (`sesame lock`) |
| `fail.revoked` | fail | never | user | politique `revoked` |
| `fail.access_refused` | fail | never | user | politique `ask` : refus ou sans réponse |
| `fail.no_secret` | fail | never | admin | aucun identifiant enregistré |
| `fail.unknown_site` | fail | never | admin | site inconnu |
| `fail.keychain_waiting` | fail | later | user | `attente_trousseau` (inchangé, plus le code) |
| `fail.browser` | fail | later | admin | Chrome injoignable, port occupé, attache impossible |
| `fail.extension` | fail | later | admin | pont/extension injoignable, non authentifié |
| `fail.uncertain` | fail | human | user | secret parti vers l'extension sans réponse |
| `fail.unexpected` | fail | later | admin | exception non classée |

API : `export function outcome(code, extra = {})` renvoie `{ outcome, code, retry, actor, ...extra }`
d'après la table (`OUTCOMES`), et `export function withOutcome(result, code, extra)` fusionne dans un
résultat existant sans écraser ses champs. `ok` reste la vérité pour l'ancien appelant :
`outcome === "ok"` ⇔ `ok === true`. `pending.*` ⇒ `ok: false` (comportement actuel conservé).

`server.js` : description des outils enrichie d'une phrase (« la réponse porte `outcome`, `code`,
`retry`, `actor` ») ; `sesame_list_sites` ajoute par site `session: { state, since, lastProbe, lastLogin,
lastCode }` et `lockedUntil` (voir §4), lus depuis l'état. `guarded()` : une exception devient
`fail.unexpected` ; `/Site inconnu/` → `fail.unknown_site`.

## 2. Sonde avant connexion — `browser.js` + `login.js`

Nouveau champ de site, facultatif, **transmis tel quel par l'atelier** :

```json
"session": { "probeUrl": "https://…", "aliveSel": "css", "deadUrlRe": "regex", "probe": true, "keepTab": true }
```

- `probeUrl` : page interne légère à ouvrir pour sonder (défaut : l'URL courante de l'onglet si elle est
  hors page de connexion, sinon `loginUrl`).
- `aliveSel` : sélecteur visible seulement connecté (défaut : heuristique `looksSignedIn`).
- `deadUrlRe` : regex d'URL de session morte (page de connexion, `/logout`, `/signin`…).
- `probe: false` désactive la sonde pour ce site. `keepTab: true` : l'onglet ne doit jamais être fermé
  par une veille (atelier) — lu par le moteur, ignoré ici.

`export async function probeSession(browser, site, { onEvent } = {})` dans `browser.js` :

1. `page = await claimSiteTab(browser, site)` (un onglet par site, doublons fermés).
2. **Défi en cours → aucune navigation.** Si la page montre un champ mot de passe, un champ de code
   (`detectSecondFactor` ≠ null) ou un captcha (`detectCaptcha`, §3) : renvoyer
   `{ state: "challenge", page, url, reason }`.
3. Sinon : cible = `session.probeUrl` ; à défaut, l'URL courante si elle est sur le site et ne ressemble pas à
   une page de connexion/déconnexion (même regex que `looksSignedIn`), sinon `loginUrl`. Pas d'onglet →
   `openPage(browser, cible)`. Onglet → `page.goto(cible)`. Attendre `domcontentloaded`, puis jusqu'à 8 s par
   pas de 500 ms tant que ni formulaire, ni signe de session, ni `deadUrlRe`, ni `aliveSel` (la page redirige
   peut-être encore).
4. Verdict, dans cet ordre : `deadUrlRe` ⇒ `dead` ; `aliveSel` visible ⇒ `alive` ; `hasLoginFields` ⇒ `dead` ;
   `looksSignedIn` ⇒ `alive` ; sinon `unknown`.
5. Renvoie `{ state: "alive"|"dead"|"unknown"|"challenge", page, url: publicUrl(...), reason }` et appelle
   `onEvent({ result: "sonde", detail })`.

`login()` : la sonde s'exécute **après** les refus immédiats (verrou global, politique `revoked`, verrou
d'essais §4, absence de secret) et **avant** la demande d'accès (`ask`) et toute lecture de secret, sur le
canal Chrome Sésame (par l'extension, pas de sonde : comportement inchangé). Si `alive` : journal
`action: "login", result: "réussi", detail: "session vivante (sonde), aucun secret lu"` (ou « secret déjà lu
par l'extension, rien saisi » quand la sonde passe après un repli extension → Chrome Sésame), `touchLastUsed`,
état `alive`, réponse `ok.already_signed_in` avec `probe: true` et `confidence` (`high` si `aliveSel`,
`medium` sinon). Si `challenge` : on reprend sur cette page sans la quitter. Si `dead`/`unknown` et que la
page n'a pas de formulaire : `gotoLogin(page, loginUrl, site)` comme avant. Le reste du flux est inchangé.
L'ancien chemin « onglet sans formulaire → `gotoLogin` » **n'est plus jamais pris avant la sonde**.

`export async function probe({ site, caller })` dans `login.js` : sonde seule (connexion CDP, `probeSession`,
journal `action: "sonde"`, état, fermeture de la connexion CDP sans fermer Chrome), renvoie
`{ ok: true, state, url, outcome: "ok", code: state === "alive" ? "ok.already_signed_in" : "ok.probed" }`
— ajouter `ok.probed` (ok, never, none) à la table. Sert au moteur de l'atelier (op `sonder`) pour éviter
Face ID quand la session est vivante.

## 3. Classifieur après soumission — `browser.js`

- `export async function detectCaptcha(page)` : vrai si une frame de **défi** effectivement visible est à
  l'écran — URL ou `src` de défi (`/bframe`, `hcaptcha.com/captcha`, `challenges.cloudflare.com/…/(turnstile|challenge)`,
  `arkose|funcaptcha|captcha-delivery|awswaf|datadome|perimeterx`) d'au moins 200×100, ou ancre reCAPTCHA v2
  (`…/anchor`, case « Je ne suis pas un robot ») d'au moins 200×60 **hors** `size=invisible` et hors
  `.grecaptcha-badge` ; dans la fenêtre, sans `visibility: hidden` / `display: none` / `opacity: 0` sur
  l'élément ou ses ancêtres. Le badge reCAPTCHA v3/invisible, présent en permanence sur les pages d'un site
  qui l'utilise, **ne compte jamais** (révision du 08/11/2026 : il faisait répondre `fail.captcha` et poser le
  verrou du jour sur une session vivante). Ou si le texte visible de la page contient
  `/captcha|je ne suis pas un robot|not a robot|v[ée]rifi\w* (que vous )?[êe]tes (bien )?humain|make sure you.re human|prove you.re human|verif\w* (that )?you are human|confirm (that )?you are human|just a moment/i`
  (le mot « challenge » nu est exclu : « Managed Challenge » dans un tableau Cloudflare n'est pas un défi ;
  tester sur `document.body.innerText` tronqué aux 4000 premiers caractères visibles, mention passive
  « protégé par reCAPTCHA » retirée).
- `export async function readFormError(page, site, field)` : texte d'erreur visible près du formulaire
  (éléments `[role=alert], .error, .alert, [class*=error], [class*=invalid], [aria-invalid=true] ~ *,
  [id*=error], .help-block, .form-text` dans le `<form>` du champ ou ses 6 ancêtres) correspondant à
  `/incorrect|invalid|invalide|erron|wrong|doesn.t match|ne correspond|try again|r[ée]essay|unrecognized|non reconnu|inconnu|verrouill|locked|too many|trop de tentatives|refus|denied|unable to (sign|log)|impossible de vous/i`.
  Renvoie le texte (≤ 120 caractères, sans URL — `scrubUrls`) ou null. **Jamais** renvoyer un texte
  contenant la valeur du mot de passe ou de l'identifiant (comparer et masquer : `[masqué]`).
- Après soumission, quand le champ mot de passe est encore là (branche `!passwordGone` de `fillLogin`) :
  SSO/fournisseur ⇒ `fail.provider_needed` (inchangé) ; `detectCaptcha` ⇒ `fail.captcha` ;
  `readFormError` ⇒ `fail.password_rejected` avec `errorText` ; sinon `fail.form_unchanged`.
  Le champ est vidé dans tous les cas (inchangé).
- Deux étapes, pas de champ mot de passe après l'identifiant (branche `!pass && user`) : `detectCaptcha` ⇒
  `fail.captcha` ; sinon si `successUrl` atteint ou `aliveSel` visible ou `looksSignedIn` ⇒
  `ok.signed_in_after_step1` (étape « session ouverte dès l'identifiant ») ; `readFormError` ⇒
  `fail.password_rejected` (identifiant inconnu) ; sinon `fail.no_password_step`.
- Succès (`passwordGone`, pas de 2e facteur) : `detectCaptcha` ⇒ `fail.captcha` (interstitiel après
  soumission, jugé **avant** `successUrl` : le défi de Booking s'affiche sur `account.booking.com`, pas sur
  l'extranet attendu) ; sinon `successUrl` manqué ⇒ `fail.landed_elsewhere` ; sinon `ok.signed_in` avec
  `confidence` (§1).
- `waitCode()` (Chrome Sésame et extension) : aucun 2e facteur détecté **et** champ mot de passe visible
  ⇒ `ok: false`, `fail.form_still_visible` ; aucun 2e facteur et `looksSignedIn` ⇒ `ok: true`,
  `ok.no_code_pending`, `confidence: medium` ; sinon `ok.no_code_pending`, `confidence: low`.
  Supprimer la variable morte `stillPassword` (login.js:518-522).

## 4. Mémoire des échecs et verrou d'essais — `src/state.js` (nouveau)

Fichier `HOME/state/sessions.json` (dossier 0700, fichier 0600, écriture atomique `.tmp` + `rename`).
Par site :

```json
{ "state": "alive|dead|unknown|blocked", "since": "ISO", "lastProbe": "ISO", "lastLogin": "ISO",
  "lastOutcome": "ok|pending|fail", "lastCode": "…", "lastUrl": "origine+chemin",
  "failures": [{ "ts": "ISO", "code": "…" }], "lockedUntil": "ISO|null", "lockReason": "…" }
```

API : `readState()`, `siteState(key)`, `recordProbe(key, state, url)`, `recordOutcome(key, result)`
(met `state` : `ok.*` ⇒ `alive`, `fail.rate_limited` ⇒ `blocked`, autres `fail.*` ⇒ `dead`, `pending.*` ⇒
inchangé ; ajoute aux `failures` (20 derniers) les codes **bloquants** : `fail.captcha`,
`fail.password_rejected`, `fail.form_unchanged`, `fail.no_password_step`, `fail.landed_elsewhere`),
`checkLock(site)` → `{ locked, until, reason }`, `unlockSite(key)`, `attemptsToday(key)`. Un verdict **passif**
(`probe: true` : la sonde a vu un captcha sur l'onglet, rien lu, rien soumis) est noté dans `lastCode` mais
**ne compte pas** comme essai et ne passe pas l'état à `dead` — le verrou mesure les tentatives réelles.
Un échec qui ne dit rien de la session du site (`NO_SESSION_INFO_CODES` : `fail.browser`, `fail.extension`,
`fail.keychain_waiting`, `fail.unexpected`, `fail.uncertain`, `fail.locked`, `fail.revoked`,
`fail.access_refused`, `fail.no_secret`, `fail.unknown_site`, `fail.domain_approval`, `fail.tab_left`) laisse
l'état tel quel : « dead » veut dire « le site a montré que la session est morte ». Si l'état ne peut pas
être écrit, `login()`/`waitCode()` répondent quand même, mais journalisent une ligne `action: "état"` et
posent `stateWarning` dans la réponse (le verrou ne se poserait pas : ne jamais l'avaler en silence).
Écriture de `sessions.json` sous verrou inter-processus (`sessions.json.lock`, `wx`, repris après 10 s,
attente ≤ 1 s) et fichier temporaire à nom unique (`.<pid>.<ms>.tmp`) : plusieurs serveurs MCP Sésame
tournent en même temps sur le Mac. Même nom unique pour `sites.json` (`saveSites`).

Règle : `site.limits?.attemptsPerDay` ; défaut **1** si le domaine du site ou l'un de ses `extraDomains`
est `booking.com`, `beds24.com`, `expediapartnercentral.com` ou `expediagroup.com`, **2** sinon. Un essai
« compte » quand il se termine par un code bloquant. Quand le nombre d'essais bloquants du jour civil
(heure locale) atteint le plafond : `lockedUntil` = **prochain** 09:30 heure locale (aujourd'hui 09:30 si
l'échec a lieu dans la nuit avant 09:30, sinon le lendemain 09:30), `lockReason` = dernier code. `login()` vérifie le verrou juste après `revoked` et **avant** la sonde : s'il est posé, réponse
`fail.rate_limited` avec `retryAfter`, `message` lisible (« Sésame n'essaie plus sur « beds24 » avant le
09/11 09:30 : dernier échec « captcha ». ») et `human` (« ouvre la page toi-même : sesame_open_login, puis
sesame_wait_code si un code est demandé ; ou lève le verrou : sesame unlock-site beds24 »). Le verrou ne
touche ni `probe()`, ni `waitCode()`, ni `openLogin()`. Variable `SESAME_NO_LOCK=1` pour les bancs d'essai
qui enchaînent des échecs volontaires **sauf** celui qui teste le verrou.

CLI `bin/sesame.js` : `sesame state [site]` (affiche l'état, jamais de secret) et `sesame unlock-site <site>`.

## 5. Cases « rester connecté / faire confiance » — `browser.js`

`async function tickRememberMe(page, site, field, steps, mask = [])` : appelée **juste avant chaque `submit`**
(étape 1, mot de passe, code), sauf si `site.rememberMe === false`. `mask` (identifiant, mot de passe) : le
libellé recopié dans `steps` passe par `maskLabel` — « [masqué] » s'il contient une valeur masquée (blancs
normalisés) ; toute adresse e-mail y est masquée aussi (« Rester connecté en tant que [masqué] »). Cherche, dans le `<form>` du champ
puis ses 6 ancêtres (même parcours que `submit`), les `input[type=checkbox]` visibles et non cochés dont
le libellé — `label[for]`, `label` parent, `aria-label`, `aria-labelledby`, ou texte du conteneur parent
immédiat (≤ 200 caractères) — correspond à
`/rester connect|garder ma session|se souvenir|souviens|remember|keep me (logged|signed) in|stay (signed|logged) in|trust(ed)? (this )?(device|browser|computer)|faire confiance|appareil de confiance|navigateur de confiance|ne plus (me )?demander|don.t ask again|conserver la connexion|m[ée]moriser|rester identifi/i`
et **pas** à
`/newsletter|offre|promo|marketing|actualit|cgu|cgv|conditions|terms|privacy|confidentialit|cookie|consent|accept|j.accepte|i agree|publicit|partenaire/i`.
Clique le libellé (sinon la case), vérifie `checked`, `steps.push("case « rester connecté » cochée (« <libellé> »)")`.
Une seule case par étape ; frame vérifiée par `onSite` ; aucune exception ne remonte.

## 6. Chrome : profil qui reprend sa session, arrêt propre — `browser.js`

- `export function prepareChromeProfile()` appelée dans `launchChromeOnce` **avant** `spawn`, et seulement si
  aucun processus Chrome ne tourne sur ce profil (`pgrep -f -- --user-data-dir=<profil>` vide) :
  - supprime `SingletonLock`, `SingletonSocket`, `SingletonCookie` à la racine du profil s'ils traînent ;
  - si `Default/Preferences` existe, le lit (JSON) et y pose `session.restore_on_startup = 1`,
    `profile.exit_type = "Normal"`, `profile.exited_cleanly = true`, `credentials_enable_service = false`,
    `profile.password_manager_enabled = false` ; écrit atomiquement ; ignore toute erreur en la
    journalisant par `onEvent` si fourni. Sans `Preferences` (premier lancement) : crée `Default/` et un
    `Preferences` minimal avec ces clés.
  - Sur Linux (atelier), les mêmes clés valent ; les politiques gérées, c'est l'affaire de l'installateur.
- Le Chrome Sésame lancé par un processus lui **survit** : aucun SIGTERM à la sortie du processus (plusieurs
  clients MCP le partagent, l'utilisateur y travaille). Le filet « exit » n'existe que pour les bancs d'essai
  (`SESAME_CHROME_HEADLESS=1`) ou sur demande explicite (`SESAME_KILL_CHROME_ON_EXIT=1`) — `killChromeOnExit()`.
- `killSesameChrome()` : d'abord un arrêt propre par le protocole (`chromium.connectOverCDP` →
  `browser.newBrowserCDPSession()` → `send("Browser.close")`, attente ≤ 8 s de la fin des processus), puis
  seulement SIGTERM, puis SIGKILL après `waitMs`. `stopLaunchedChrome()` (bancs d'essai) : même arrêt propre
  si possible, SIGTERM sinon.

## 7. Tests (Chromium headless, pages locales, comme `test/one-tab.mjs`) — ajoutés à `npm run check`

- `test/probe.mjs` : (a) 1re connexion remplit, 2e et 3e → `ok.already_signed_in`, `probe: true`, **`readSecret`
  appelé une seule fois en tout** (espion passé par `readSecret`), **`/login` jamais redemandé** après la 1re
  fois (compteur côté serveur) ; (b) `session.probeUrl` honoré ; (c) `deadUrlRe` qui correspond ⇒ sonde `dead`
  puis connexion normale ; (d) page sur un champ de code ⇒ `challenge`, **aucune navigation** (compteur).
- `test/outcomes.mjs` : page d'erreur « mot de passe incorrect » ⇒ `fail.password_rejected` + `errorText` sans
  le mot de passe ; iframe `recaptcha` ⇒ `fail.captcha`, `retry: human` ; formulaire inchangé ⇒
  `fail.form_unchanged` ; deux étapes avec redirection connectée après l'identifiant ⇒
  `ok.signed_in_after_step1` ; `waitCode` sur un formulaire ⇒ `fail.form_still_visible` ; tout résultat porte
  `outcome`, `code`, `retry`, `actor`.
- `test/locks.mjs` : site `limits.attemptsPerDay: 1` ; 1er essai refusé ⇒ `fail.password_rejected`, 2e ⇒
  `fail.rate_limited` **sans lecture du secret** (espion), `retryAfter` au lendemain 09:30 local, état
  `blocked` ; `unlockSite` ⇒ essai possible ; défaut 1 pour un site dont `extraDomains` contient `beds24.com`.
- `test/remember-me.mjs` : formulaire avec cases « Rester connecté » et « Recevoir la newsletter » ⇒ le serveur
  reçoit `remember=on` et pas `newsletter` ; `rememberMe: false` ⇒ rien coché.
- `test/chrome-profile.mjs` : `prepareChromeProfile` sur un profil temporaire pose les clés, nettoie
  `Singleton*`, ne touche à rien si un faux processus « tourne » (variable d'injection pour le test).
- Les tests existants (`smoke`, `one-tab`, `keep-connected`, `sso`, `wrong-account`, `chrome-frozen`, `imap`,
  `http`, `bridge`) **restent verts** ; `one-tab` doit toujours voir `alreadySignedIn: true` aux 2e et 3e
  connexions (désormais par la sonde).

## 8. Hors de cette tranche (tranche 2, même étape)

Fournisseurs de codes unifiés (e-mail, lien magique, TOTP, relais iPhone), registre anti-rejeu, canari IMAP
quotidien, veille déterministe dans le moteur, un onglet par **site** (et non par domaine), bouton « Pause »
dans l'app, sept jours à blanc. Côté atelier (dépôt `fil-rouge`) : op `sonder` du moteur appelée par le coffre
avant toute demande Face ID, transmission des champs `session`, `successUrl`, `rememberMe`, `limits` par
`sites_pour_moteur()`, respect de `session.keepTab` par la fermeture après `REPOS_MIN`.
