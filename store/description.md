# Chrome Web Store — fiche produit de l'extension « Sésame »

Tout ce qu'il faut coller dans le formulaire de soumission (developer.chrome.com/webstore), en français
et en anglais, plus la justification de chaque permission (le formulaire de revue Google demande une
phrase par permission) et la procédure de publication pas à pas.

L'extension travaille avec l'application Sésame, à installer sur le même Mac (téléchargement gratuit sur
[sesamekey.app](https://sesamekey.app) : on glisse l'app dans Applications, on l'ouvre, elle fait le
reste). C'est le prérequis à annoncer clairement dans la fiche. Voir [README.md](../README.md) et
[SECURITY.md](../SECURITY.md).

---

## Résumé (132 caractères max — champ « Summary »)

**FR** (117 caractères) :

> Sésame remplit vos identifiants dans Chrome pour Claude, sans jamais les lui montrer. Tout reste local sur votre Mac.

**EN** (116 caractères) :

> Sésame fills in your login for Claude, without ever showing it your credentials. Everything stays local on your Mac.

## Description longue

### FR

Sésame laisse un assistant IA (Claude) se connecter à vos comptes web à votre place, **sans jamais lui
révéler un identifiant ou un mot de passe**.

Le principe : au lieu de donner votre mot de passe à l'assistant, vous le stockez une fois dans le
Trousseau macOS. Quand Claude a besoin de se connecter à un site que vous avez enregistré, il le demande
à Sésame — un serveur qui tourne sur votre Mac, pas dans le cloud. Sésame lit le secret dans le Trousseau,
et **cette extension** le tape dans le formulaire de connexion, dans votre Chrome habituel. Claude ne
reçoit en retour que « connecté », « refusé » ou « échec » : jamais la valeur d'un champ.

Ce que fait précisément l'extension :
- reçoit une demande de remplissage du pont natif Sésame (processus local, pas un serveur distant) ;
- trouve ou ouvre l'onglet du site concerné ;
- remplit le champ identifiant, valide une éventuelle étape intermédiaire, remplit le mot de passe,
  soumet le formulaire ;
- si le site demande un code de vérification (SMS, e-mail, application), le signale (bandeau, badge sur
  l'icône, notification système) et attend que **vous** le tapiez vous-même — l'extension ne le lit jamais ;
- renvoie le résultat au pont : jamais les identifiants, seulement des étapes descriptives et un code de
  résultat.

Ce que l'extension ne fait jamais :
- elle ne stocke aucun identifiant, aucun mot de passe, nulle part ;
- elle ne communique avec aucun serveur distant — uniquement avec le pont natif Sésame, en local, via la
  messagerie native de Chrome ;
- elle n'a aucune analytique, aucun télémétrie, aucune publicité.

**Prérequis :** cette extension seule ne suffit pas. Elle a besoin du reste de Sésame (serveur MCP + pont
natif) installé sur le même Mac — voir [sesamekey.app](https://sesamekey.app) et le dépôt
[github.com/sambisou/sesame](https://github.com/sambisou/sesame). Sésame est gratuit et open source
(licence MIT).

Politique de confidentialité : [sesamekey.app/privacy.html](https://sesamekey.app/privacy.html).

### EN

Sésame lets an AI assistant (Claude) log in to your web accounts on your behalf — **without ever showing
it a username or password**.

The idea: instead of handing your password to the assistant, you store it once in the macOS Keychain.
When Claude needs to log in to a site you've registered, it asks Sésame — a server that runs on your Mac,
not in the cloud. Sésame reads the secret from the Keychain, and **this extension** types it into the
login form, in your everyday Chrome. Claude only ever gets back "logged in", "refused", or "failed" —
never a field's value.

What the extension actually does:
- receives a fill request from the local Sésame native bridge (a process on your Mac, not a remote
  server);
- finds or opens the tab for the site in question;
- fills the username field, confirms an intermediate step if the site has one, fills the password,
  submits;
- if the site asks for a verification code (SMS, e-mail, app), signals it (banner, badge on the icon,
  system notification) and waits for **you** to type it — the extension never reads it;
- reports the result back to the bridge: never the credentials, only descriptive steps and a result code.

What the extension never does:
- it stores no credential, anywhere;
- it talks to no remote server — only to the local Sésame native bridge, via Chrome's own native
  messaging;
- no analytics, no telemetry, no ads.

**Requirement:** this extension alone is not enough. It needs the rest of Sésame (MCP server + native
bridge) installed on the same Mac — see [sesamekey.app](https://sesamekey.app) and the repository
[github.com/sambisou/sesame](https://github.com/sambisou/sesame). This is a personal, free, open-source
project (MIT), provided as is.

Privacy policy: [sesamekey.app/privacy.html](https://sesamekey.app/privacy.html).

---

## Justification de chaque permission (formulaire de revue Google)

Coller une phrase par permission dans le champ correspondant du formulaire « Permission justification ».

| Permission | Justification (à coller) |
|---|---|
| `nativeMessaging` | Required to communicate with the local Sésame bridge process running on the user's own Mac (native messaging host `app.sesamekey.bridge`), which is the only source of fill requests and results. No network communication is involved. |
| `tabs` | Required to find an already-open tab whose URL matches the requested site's domain (so we reuse an existing session) or, if none exists, to open the site's login page in a new tab before filling it. |
| `scripting` | Required to inject the login-filling content script into the target page on demand, only when a fill request names that page — never declared as a persistent content script running on every site. |
| `storage` | Required to remember the bridge connection status shown in the extension's popup (e.g. "connected" / "not connected", session storage). The local area holds a single optional key, `bridgeName`, honoured only when the extension is loaded unpacked (developer mode) so the automated test bench can point it at a temporary bridge; a packaged build ignores it. Never used to store a credential. |
| `notifications` | Required to tell the user, outside the page, that the site is asking for a verification code they must type themselves (a system notification naming the site), alongside a badge on the extension icon. Nothing else is ever notified. |
| `host_permissions: <all_urls>` | Required because the site to fill is whichever one the user has registered in Sésame (any domain, decided entirely by the user on their own Mac) and is not known ahead of time. The extension only reads or modifies the DOM of the one tab named in an explicit, user-approved fill request — it runs no code on any other page. |

Justification globale du fonctionnement à un seul but (« single purpose », demandée en tête du
formulaire) :

> This extension has a single purpose: to fill in a login form (username, password, and an
> intermediate step if present) on a page the user has explicitly registered with the companion
> Sésame application on their own Mac, at the request of that same local application — nothing else.

---

## Icônes et captures d'écran

- Icônes : `extension/icons/16.png`, `48.png`, `128.png` (graine dorée sur fond sombre, même dessin que
  le logo du site — voir `site/index.html`, symbole `#mark`).
- Captures d'écran (1280×800 ou 640×400, jusqu'à 5) : à préparer à partir du popup de l'extension et,
  idéalement, d'un remplissage en cours sur le banc d'essai (`test/2fa-page.html`). Pas de mise en scène
  avec un vrai site tiers dans les captures publiques.
- Icône du store (128×128) : réutiliser `extension/icons/128.png`.

## Catégorie et visibilité suggérées

- Catégorie : **Productivity** (ou **Developer Tools**, selon ce que propose le formulaire au moment de la
  soumission).
- Visibilité : **Unlisted** tant que le reste de Sésame (serveur MCP, pont natif) n'est pas dans un état
  jugé prêt pour un public plus large que toi-même ; passer en **Public** est une décision à prendre
  séparément, pas automatique après la première publication.

---

## Procédure de publication (Chrome Web Store), pas à pas

Cette partie est pour toi (Sam) : la publication elle-même n'est pas automatisable depuis ce dépôt, ni
faite par un agent.

1. **Compte développeur.** Va sur
   [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole/), connecte-toi
   avec le compte Google que tu veux voir associé à l'extension, et paie les **5 $ US, une seule fois**
   (carte bancaire) si tu n'as pas déjà de compte développeur Chrome Web Store.
2. **Prépare le zip.** Depuis la racine du dépôt :
   ```bash
   cd extension && zip -r ../sesame-extension.zip . -x '*.DS_Store'
   ```
   Le zip doit contenir `manifest.json` à sa racine (pas un sous-dossier `extension/` à l'intérieur).
3. **Nouvel article.** Dans la console développeur, « New item » → dépose `sesame-extension.zip`.
4. **Store listing.** Colle le résumé et la description longue (section FR ou EN ci-dessus — le Store
   n'accepte qu'une langue par défaut, tu peux ajouter des traductions ensuite dans « Store listing languages »).
   Ajoute les captures d'écran et l'icône 128×128.
5. **Privacy practices.** Renseigne l'URL de la politique de confidentialité :
   `https://sesamekey.app/privacy.html`. Pour chaque permission listée dans le formulaire, colle la
   justification correspondante ci-dessus. Coche qu'aucune donnée personnelle n'est collectée (c'est le
   cas : voir la page de confidentialité).
6. **Distribution.** Choisis la visibilité (Unlisted recommandé au départ, voir plus haut) et les régions
   (toutes, ou seulement France si tu préfères limiter la portée au début).
7. **Soumission.** « Submit for review ». Google annonce généralement quelques jours à quelques semaines
   de délai pour une première revue, plus long si la permission `<all_urls>` déclenche un examen manuel
   approfondi (probable ici — prépare-toi à répondre à des questions de l'équipe de revue sur l'usage
   exact des permissions, en pointant vers ce fichier et vers SECURITY.md si besoin).
8. **Après publication.** Note l'ID définitif de l'extension (il ne change plus une fois publié) et
   mets à jour, si besoin, le manifeste de messagerie native (`sesame install extension --id <id>`) sur
   ta propre machine avec cet ID stable au lieu de celui, temporaire, obtenu en mode développeur.
9. **Mises à jour futures.** Chaque nouvelle version se publie en déposant un nouveau zip avec un
   `version` incrémenté dans `manifest.json` ; la revue est généralement plus rapide pour une mise à jour
   que pour la première soumission, sauf changement de permissions.
