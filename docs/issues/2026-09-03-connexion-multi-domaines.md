# Sésame — connexion abandonnée quand le mot de passe se saisit sur un autre domaine

**Date :** 2026-09-03 · **Rapporté par :** session Claude Code (téléphonie / Expedia) · **Gravité :** bloquant pour les sites concernés

## Symptôme

`sesame_login(site: "expedia")` remplit l'e-mail, clique « Suivant », puis s'arrête :

```
{ ok: false,
  message: "onglet parti vers https://accounts.expediagroup.com/partner/password : remplissage abandonné",
  steps: ["identifiant rempli", "étape 1 validée (bouton)"],
  url: "https://accounts.expediagroup.com/partner/password" }
```

Un second `sesame_login` répond ensuite `Aucun onglet Chrome ouvert sur expediapartnercentral.com.` :
l'onglet existe mais son hôte n'est plus reconnu comme faisant partie du site.

Reproduction : site `expedia`, `loginUrl = https://www.expediapartnercentral.com/`. La page 1
(e-mail) est sur `www.expediapartnercentral.com`, la page 2 (mot de passe) est sur
`accounts.expediagroup.com/partner/password`, puis la page 3 (code MFA) revient sur
`www.expediapartnercentral.com/account/mfa/initiate`. Deux domaines enregistrables
différents : `expediapartnercentral.com` et `expediagroup.com`.

Même famille de cas : Orange (`login.orange.fr` → `espaceclientpro.orange.fr`, OK car même
domaine enregistrable), Ubiquiti (`account.ui.com` → `unifi.ui.com`, OK), Infomaniak
(`login.infomaniak.com` → `manager.infomaniak.com`, OK). Ce qui casse, c'est un fournisseur
d'identité sur un **autre** domaine enregistrable — de plus en plus courant (Expedia Group,
Microsoft `login.microsoftonline.com`, Okta, Auth0, Amazon `ap/signin` sur un autre TLD…).

## Cause

- `src/config.js` : `siteDomainFor(url)` réduit le périmètre au domaine enregistrable de
  `loginUrl` (`expediapartnercentral.com`).
- `src/config.js:91` et `extension/background.js:241` : `siteMatchesUrl(site, url)` accepte
  `site.domain` **et `site.extraDomains`** — le mécanisme existe.
- `src/browser.js:394` (`fillLogin`, `gone()`) et `extension/background.js:487` : avant chaque
  frappe, si `!siteMatchesUrl(site, page.url())` → abandon. Pareil pendant l'attente du code
  (`src/browser.js:361`, `background.js:463`).
- `src/login.js:131` / `:374` : la recherche d'onglet utilise `siteMatchesUrl` → « Aucun onglet ».
- **Mais `extraDomains` n'est renseignable nulle part** : ni `sesame add`, ni
  `sesame_request_site`, ni la fenêtre de l'app. Seule voie : éditer `~/.sesame/sites.json` à la
  main (`"extraDomains": ["expediagroup.com"]`), ce que la politique « jamais de terminal »
  du 02/09 rend contradictoire.

## Correctifs proposés (par ordre de valeur/effort)

1. **Exposer `extraDomains`** dans `sesame add --extra-domain …`, dans `sesame_request_site`
   (paramètre `extraDomains: string[]`, validé `https` + domaine enregistrable) et dans la
   fenêtre « nouveau site » de l'app (champ « autres domaines de connexion »). Effort faible,
   corrige Expedia immédiatement.
2. **Apprentissage assisté** : quand `fillLogin` détecte que la navigation quitte le
   périmètre **et** que la nouvelle page présente un champ mot de passe, au lieu d'abandonner
   silencieusement, afficher un dialogue macOS : « expedia redirige vers
   accounts.expediagroup.com pour le mot de passe. Autoriser ce domaine pour ce site ? »
   → si oui, `extraDomains.push(domaineEnregistrable)`, sauvegarde `sites.json`, reprise du
   remplissage. Sinon abandon comme aujourd'hui. Garde-fous : jamais d'ajout automatique
   sans validation humaine ; refuser les `SHARED_SUFFIXES` ; journaliser l'ajout.
3. **Reprise après MFA** : `mfa/initiate` sur le domaine d'origine est ensuite reconnu, mais
   `sesame_login` relancé repart du formulaire e-mail. Prévoir `sesame_wait_code(site)` capable
   de reprendre un onglet déjà sur l'étape code même si `fillLogin` n'a pas été appelé dans la
   même session.

## Observations secondaires (même session)

- **`sesame_request_site` expire côté MCP (~60 s)** alors que la fenêtre Sésame reste ouverte
  (« attente » dans le journal). L'IA reçoit `Request timed out` et croit à un échec ; l'utilisateur
  remplit plus tard sans que personne ne le sache. Proposition : réponse immédiate
  `{status:"attente", requestId}` + outil `sesame_request_status(requestId)` (ou `sesame_journal`
  suffit) ; ne jamais rouvrir une seconde fenêtre si une demande est déjà « attente ».
- **Yealink T43U (`https://192.168.0.176/`)** : page de login avec identifiant + mot de passe
  visibles, mais `sesame_login` a d'abord « identifiant rempli, étape 1 validée (bouton) » sans
  remplir le mot de passe (heuristique deux étapes déclenchée à tort — champ mot de passe non
  détecté au premier passage, probablement rendu après l'hydratation). Au second essai, OK.
  Proposition : quand un champ mot de passe est visible dans la même frame, ne jamais cliquer
  le bouton avant de l'avoir rempli ; sinon attendre 1 s et re-localiser avant de décider.
- Journal Sésame : `~/.sesame/journal.jsonl` (entrées `expedia` du 2026-09-03).
