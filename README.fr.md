# Sésame — coffre d'identifiants local pour Claude

> 🇬🇧 [English README](README.md) · Site : [sesamekey.app](https://sesamekey.app) · Licence [MIT](LICENSE) · [Sécurité et signalement](SECURITY.fr.md)
>
> Sésame manipule vos identifiants, autant savoir comment : [SECURITY.fr.md](SECURITY.fr.md) explique exactement ce qu'il fait, ce qu'il ne fait jamais, et où sont les limites. Gratuit et open source sous licence MIT, donc fourni sans garantie.

Sésame permet à Claude (Cowork, Claude Code, Claude Desktop) de **se connecter à tes comptes web sans jamais connaître tes identifiants**.

Le principe : Claude ne demande pas *« donne-moi le mot de passe EDF »*, il demande à Sésame *« remplis le formulaire EDF dans l'onglet Chrome »*. Sésame lit le secret dans le **Trousseau macOS**, le tape lui-même dans la page, et renvoie à Claude uniquement *« fait / refusé / échec »*. Chaque demande est **journalisée** et, par défaut, **tu valides chaque accès** par une boîte de dialogue sur ton Mac.

```
   Claude (Cowork / Code)            Sésame (serveur MCP local)             Chrome « Sésame »
 ─────────────────────────         ──────────────────────────────         ────────────────────
 sesame_login("edf",        ──►    politique du site ? (ask/always/revoked)
   reason="facture août")          Bloquer global ?
                                   ├─ ask → boîte de dialogue macOS ──► toi : Autoriser / Refuser
                                   ├─ Trousseau macOS → identifiant + mot de passe
                                   ├─ trouve l'onglet edf.fr (ou l'ouvre)   ──►  tape les champs, soumet
                                   └─ journal.jsonl : qui, quand, quoi, résultat
 ◄── { ok: true, steps: [...] }    (jamais les valeurs)
```

## Ce que Claude peut et ne peut pas faire

| Outil MCP | Ce qu'il fait | Ce qu'il renvoie |
|---|---|---|
| `sesame_list_sites` | liste les sites connus | noms, domaines, politiques — **pas de secret** |
| `sesame_login` | remplit et soumet le formulaire de connexion dans Chrome, attend un code de 2e facteur si le site en demande un | `ok / refusé / échec` + étapes + URL |
| `sesame_wait_code` | reprend l'attente d'un code de 2e facteur que tu tapes toi-même | `ok / échec` |
| `sesame_request_site` | quand un site n'est pas encore enregistré : ouvre une fenêtre Sésame sur le Mac pour que **toi** tu saisisses identifiant et mot de passe (directement dans le Trousseau) — **non bloquant** : répond tout de suite avec `status: "attente"` et un `requestId` | `attente` + `requestId` — jamais les valeurs |
| `sesame_request_status` | suit une demande `sesame_request_site`, sans jamais bloquer | `attente / enregistré / refusé / expiré` |
| `sesame_open_login` | ouvre la page de connexion d'un site | URL |
| `sesame_journal` | lit le journal d'accès | événements |

Il **n'existe aucun outil** qui renvoie un identifiant ou un mot de passe. Les secrets ne quittent jamais le processus Sésame ↔ Trousseau ↔ Chrome, tous sur ton Mac. Les messages d'erreur sont tronqués et ne contiennent jamais de valeur de champ.

## Installation (deux minutes)

Prérequis : macOS 13 ou plus récent, et Google Chrome. Rien d'autre — Sésame emporte tout ce qu'il lui faut.

1. Téléchargez **[Sesame.dmg](https://github.com/sambisou/sesame/releases/latest)**.
2. Ouvrez-le et glissez **Sésame** dans votre dossier Applications.
3. Ouvrez Sésame. Un court assistant le connecte à Claude, et une petite graine apparaît dans la barre
   des menus.

La première fois, macOS annonce une app d'un développeur non identifié : clic droit sur l'app →
*Ouvrir* → *Ouvrir*. (Cet avertissement disparaîtra quand l'app sera notarisée par Apple.)

Ensuite, tout se fait depuis la barre des menus : ajouter ou retirer un site, choisir sa règle, tout
bloquer, installer l'extension Chrome, lire le journal. Jamais de terminal.

<details>
<summary>Pour les développeurs : depuis le dépôt</summary>

```bash
git clone https://github.com/sambisou/sesame && cd sesame
npm install
cd macos && ./scripts/make-app.sh release   # construit macos/build/Sésame.app
npm run dmg                                 # construit l'image disque
```

`bin/sesame.js` est la CLI (`sesame doctor`, `sesame add`, `sesame install all`…). Elle demande Node 20+
depuis le dépôt ; l'app distribuée, elle, embarque son propre Node.
</details>

### Le Chrome « Sésame »

Depuis Chrome 136, Chrome refuse le pilotage à distance sur le profil par défaut. Sésame lance donc **un Chrome avec son propre profil** (`~/.sesame/chrome-profile`) et le port DevTools 9222 :

```bash
sesame chrome
```

Dans ce Chrome, la **première fois** : installe l'extension **Claude in Chrome** et relie-la à Claude Desktop, comme d'habitude. C'est dans *ce* Chrome que Claude naviguera et que Sésame remplira les identifiants. Les sessions (cookies) y restent : une fois connecté à EDF, tu restes connecté jusqu'à expiration, sans nouvel appel à Sésame.

> Astuce : pour le lancer automatiquement au démarrage, ajoute `sesame chrome` dans un Automator « Application » placé dans *Réglages système → Général → Ouverture*.

### Extension Chrome (bêta)

Une alternative au Chrome dédié ci-dessus : une **extension** qui tourne dans ton Chrome **habituel** — plus de second navigateur, plus de port DevTools. Sésame la joint via un petit processus pont local, sur le canal de messagerie native de Chrome (pas le réseau).

1. Ouvre `chrome://extensions`.
2. Active le **Mode développeur** (en haut à droite).
3. Clique **Charger l'extension non empaquetée** et choisis le dossier `extension/` de ce dépôt.
4. Copie l'ID affiché sous le nom de l'extension (32 lettres).
5. Lance :
   ```bash
   sesame install extension --id <cet-id>
   ```
   Cela écrit le manifeste de messagerie native (mode 0600) pour Chrome seulement. Tu utilises Brave, Arc, Chromium ou Chrome Canary ? Ajoute `--browser brave|arc|chromium|canary` : le manifeste n'est écrit que pour ce navigateur-là, jamais pour un navigateur où l'extension n'est pas chargée.
6. Recharge l'extension (bouton ↻ sur sa carte), ouvre son popup, clique **Tester la connexion**.

Si le popup répond *Native host has exited* juste après, et que ce dossier est dans `~/Downloads`, `~/Documents` ou `~/Bureau`, c'est probablement macOS qui refuse à Chrome d'exécuter `bin/sesame-bridge.sh` depuis là (un processus lancé par Chrome a les permissions de fichiers de Chrome) : autorise Chrome pour ce dossier dans *Réglages Système → Confidentialité et sécurité → Fichiers et dossiers*, ou déplace le dépôt ailleurs (par ex. `~/sesame`) et refais l'étape 5. Chrome lit le manifeste dans son propre dossier de données (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts` pour le profil habituel) : c'est là que l'étape 5 l'écrit.

`sesame doctor` en donne l'état : manifeste présent, pont joignable, extension connectée. Quand les trois sont au vert, `sesame_login` et `sesame_wait_code` utilisent automatiquement l'extension à la place du Chrome dédié — tu continues à naviguer normalement. Force l'un ou l'autre avec `SESAME_BROWSER=chrome-profile` ou `SESAME_BROWSER=extension` (par défaut `auto`).

Une connexion par l'extension se fait en deux temps : Sésame demande d'abord à l'extension de trouver (ou d'ouvrir) l'onglet du site et de vérifier qu'un formulaire de connexion est visible ; ensuite seulement il lit le Trousseau et envoie les identifiants, pour cet onglet-là, dans les 60 secondes. Le dialogue d'accès nomme l'endroit où les identifiants seront tapés (« votre Chrome habituel (extension Sésame) » ou « le Chrome Sésame »). Si l'extension lâche **avant** l'envoi des identifiants (pont disparu, Chrome fermé pendant le premier temps), Sésame retombe sur le Chrome dédié en mode `auto` et le signale dans `steps`. Si elle cesse de répondre **après** l'envoi, il n'y a **pas de repli** : la réponse dit « l'extension n'a pas répondu, le formulaire a peut-être été soumis : vérifie l'onglet », et le journal note la tentative comme *incertaine*. Les identifiants ne sont jamais tapés deux fois dans deux navigateurs.

**Limite honnête :** l'extension remplit le formulaire dans ton Chrome de tous les jours, où tu as peut-être d'autres extensions installées. Toute extension ayant accès au DOM de cette page peut, en principe, observer ce qui s'y tape — comme elle pourrait t'observer le taper toi-même. Le Chrome dédié ci-dessus n'a pas cette exposition, puisque rien d'autre n'y est installé. Choisis le compromis qui te convient ; voir [SECURITY.fr.md](SECURITY.fr.md) pour le détail.

## L'app de la barre des menus

`Install Sesame.command` installe aussi **Sésame.app** dans la barre des menus (une petite graine). Tout se fait depuis là, sans terminal :

- voir chaque site enregistré et changer sa règle d'un clic : **Me demander**, **Automatique**, **Coupé** ;
- ajouter un site : une seule fenêtre avec identifiant, mot de passe et un œil pour l'afficher ; le secret part directement dans le Trousseau ;
- supprimer un site (et son secret), activer le **Bloquer** global, ouvrir le Chrome Sésame, lire les dernières lignes du journal.

Quand Claude a besoin d'un site pas encore enregistré, l'app ouvre cette même fenêtre pour toi (`sesame_request_site`, non bloquant — voir plus bas) ; la fenêtre a aussi un champ optionnel « Autres domaines de connexion », pré-rempli quand Claude sait déjà qu'il en faut un. Si l'app ne tourne pas, Sésame retombe sur les boîtes de dialogue macOS.

Pour la construire toi-même : `cd macos && ./scripts/make-app.sh release` (Swift 6, macOS 14+), le bundle arrive dans `macos/build/Sésame.app`.

Note de langue : l'app, ses fenêtres, les boîtes de dialogue macOS, les notifications et le bandeau d'attente du code suivent la langue du Mac — anglais par défaut, français si la langue du système est le français. La CLI reste en français (les noms de commandes ne changent pas de toute façon), et le journal (`~/.sesame/journal.jsonl`) ainsi que les valeurs vues par Claude (`reason`, `steps`, `message`…) restent toujours en français : ce sont des données pour le modèle, pas du texte d'interface.

## Enregistrer un site

```bash
sesame add edf --url https://particulier.edf.fr/fr/accueil/connexion.html
```

Sésame te demande identifiant + mot de passe **au clavier, masqué** — c'est le seul endroit où ils sont saisis. Ils partent dans le Trousseau macOS (service `sesame`, compte `edf`) ; `~/.sesame/sites.json` ne contient que l'URL, le domaine et la politique.

Options utiles :

| Option | Rôle |
|---|---|
| `--policy ask` (défaut) | tu valides chaque connexion par une boîte de dialogue |
| `--policy always` | connexion automatique, sans dialogue (journalisée quand même) |
| `--user-sel '#email'` | sélecteur CSS du champ identifiant, si la détection automatique échoue |
| `--pass-sel '#pwd'` | idem pour le mot de passe |
| `--submit-sel 'button.login'` | idem pour le bouton de validation |
| `--note "compte pro"` | mémo affiché dans `sesame list` |
| `--extra-domain exemple.com` (répétable) | un autre domaine enregistrable où la connexion peut basculer pour le mot de passe (voir plus bas) |

Relancer `sesame add edf` sur un site existant met à jour le secret (changement de mot de passe).

**Sans terminal :** quand Claude a besoin d'un site pas encore enregistré, il appelle `sesame_request_site`. Cet appel répond tout de suite (`status: "attente"`, un `requestId`) — il ne bloque jamais Claude en attendant que tu répondes. Sésame ouvre une fenêtre sur ton Mac (identifiant, mot de passe, et un champ optionnel « autres domaines de connexion »), range tout dans le Trousseau, et Claude interroge ensuite `sesame_request_status(requestId)` jusqu'à lire `enregistré`, `refusé` ou `expiré` (pas de réponse en 10 minutes). Si l'app ne tourne pas, Sésame retombe sur trois boîtes de dialogue macOS courtes, mais bloquantes.

## Un domaine différent pour le mot de passe (fournisseurs d'identité)

Certains parcours de connexion basculent, en cours de route, vers un **domaine enregistrable distinct** — un fournisseur d'identité séparé, pas un simple sous-domaine du même site. Exemple : Expedia Partner Central demande l'e-mail sur `www.expediapartnercentral.com`, mais la page de mot de passe est servie depuis `accounts.expediagroup.com` — un domaine entièrement différent. Les sauts de sous-domaine ordinaires (`login.exemple.com` → `app.exemple.com`) ne posent aucun problème : Sésame considère déjà tout le domaine enregistrable d'un site comme son périmètre. Un domaine vraiment différent, lui, doit être explicitement autorisé — Sésame ne remplit jamais un mot de passe sur un domaine que tu n'as pas approuvé.

Trois façons de l'autoriser :

1. **À l'avance**, quand tu le sais déjà : `sesame add expedia --url https://www.expediapartnercentral.com/ --extra-domain expediagroup.com`, ou passe `extraDomains: ["expediagroup.com"]` à `sesame_request_site`.
2. **Apprentissage assisté** (le cas courant) : si `sesame_login` constate que l'onglet est parti vers un autre domaine enregistrable qui montre déjà un champ mot de passe, il n'abandonne **pas** simplement. Il te demande, sur ton Mac : *« expedia redirige vers accounts.expediagroup.com pour le mot de passe. Autoriser ce domaine pour ce site ? »* (Refuser par défaut). Dis oui une fois, et Sésame retient le domaine pour la prochaine fois **et** termine de remplir le formulaire tout de suite — pas besoin de rappeler `sesame_login`. Chaque autorisation (et chaque refus) est journalisée (`extra_domain`).
3. **À la main**, dans la fenêtre « ajouter un site » de l'app de la barre des menus : un champ optionnel « Autres domaines de connexion », séparés par des virgules.

Les domaines supplémentaires sont toujours validés de la même façon, quelle que soit leur origine : réduits à leur domaine enregistrable, jamais une adresse IP (sauf `127.0.0.1`/`localhost` pour les bancs d'essai), jamais un hébergeur mutualisé (`github.io`, `vercel.app`… où chaque sous-domaine appartient à quelqu'un d'autre), et jamais le domaine principal du site lui-même.

## Contrôler les accès un par un

```bash
sesame list                       # état de tous les sites
sesame policy edf always          # plus de dialogue pour EDF
sesame policy edf ask             # revenir à la validation manuelle
sesame revoke edf                 # couper l'accès (le secret reste dans le Trousseau)
sesame remove edf                 # supprimer site + secret
sesame lock / sesame unlock       # coupe-circuit global, tous les sites
```

## Le journal

```bash
sesame log                        # 30 dernières lignes
sesame log --site edf -n 100
```

Chaque ligne de `~/.sesame/journal.jsonl` : horodatage, site, action (`login`, `open_login`, `policy`, `lock`…), appelant (`cowork`, `claude-code`, `cli`), résultat (`autorisé`, `refusé`, `réussi`, `échec`, `erreur`) et un détail lisible. Claude peut le lire via `sesame_journal` pour te rendre compte, mais pas l'effacer.

## Une seule fenêtre, et seulement si tu le veux

Le principe premier de Sésame est d'automatiser : pour un site en règle **Automatique**, rien ne s'affiche, la connexion se fait toute seule. Il n'y a donc qu'**une** fenêtre à connaître, et elle n'apparaît que pour un site en règle **Me demander** :

1. **Sésame — demande d'accès.** Qui demande (Cowork, Claude Code…), quel site, et pourquoi. *Refuser* est le bouton par défaut ; clique **Autoriser** pour laisser Sésame remplir le formulaire.

Le Trousseau macOS, lui, ne demande rien pour les sites enregistrés depuis la 0.5.1 : c'est l'assistant Trousseau signé (`sesame-keychain`, livré dans Sésame.app) qui crée et relit chaque élément lui-même, ce qui le rend silencieux dès le premier accès — aucune boîte de dialogue, jamais de « Toujours autoriser » à cliquer. La seule exception : un site enregistré avant la 0.5.1, dont l'élément appartient encore à l'ancien outil. `sesame doctor` te dit lesquels ; corrige-les d'un coup avec `sesame migrate-keychain` — une fenêtre du Trousseau par site (clique **Autoriser**), une seule fois, puis c'est réglé pour toujours. Détails et garanties : [SECURITY.fr.md](SECURITY.fr.md).

Ensuite, si le site demande un code (SMS, e-mail, application), un bandeau apparaît en haut du Chrome Sésame et Sésame t'attend.

## Utilisation avec Claude

Tu dis simplement : *« Connecte-toi sur mon compte EDF et récupère la facture d'août. »*

Claude appelle `sesame_list_sites` pour trouver le nom `edf`, puis `sesame_login(site: "edf", reason: "récupérer la facture d'août")`. Si la politique est `ask`, une fenêtre apparaît sur ton Mac : **Autoriser / Refuser** (Refuser par défaut, expire après 90 s). Puis Claude continue à naviguer dans l'onglet avec Claude in Chrome.

Pour que Claude s'en souvienne, tu peux ajouter dans tes instructions (Cowork / CLAUDE.md) :

> Pour tout site nécessitant une connexion, ne me demande jamais mes identifiants : utilise les outils `sesame_*` (d'abord `sesame_list_sites`, puis `sesame_login` avec un motif clair). Si le site n'est pas dans Sésame, appelle `sesame_request_site` pour que je saisisse mes identifiants dans la fenêtre Sésame — ne m'envoie jamais dans un terminal.

## Le 2e facteur (code par SMS, e-mail ou application)

Le code, c'est toi qui le tapes — Sésame ne le voit jamais. Mais il ne te laisse pas seul :

1. Après le mot de passe, si le site demande un code, Sésame le détecte (champ « code de vérification », texte « envoyé par SMS »…).
2. Une notification macOS te prévient, et un **bandeau apparaît en haut de la page** dans le Chrome Sésame : « Sésame attend que vous saisissiez le code reçu… ».
3. Tu tapes le code et tu valides. Dès que le site l'accepte, le bandeau disparaît et Sésame rend la main à Claude avec « code saisi par l'utilisateur, connexion poursuivie ».
4. Sans code au bout de 3 minutes (réglable, `codeTimeoutSec`), Sésame répond « délai dépassé » et laisse le formulaire ouvert ; Claude peut reprendre l'attente avec `sesame_wait_code` quand tu es prêt.

Le journal note chaque étape (`2fa` : attente, réussi, en attente). Si un site utilise un champ de code inhabituel, précise-le avec `--code-sel` dans `sesame add`.

## Compatibilité : quels assistants ?

Sésame parle **MCP**, le protocole ouvert des outils d'assistants, sur ses deux transports standard : **stdio** (le client lance `sesame-mcp` en local) et **Streamable HTTP** (`sesame serve`, sur 127.0.0.1, avec jeton). Tout client MCP conforme peut donc l'utiliser. Voici, honnêtement, ce qui a été vérifié.

| Client | Transport | État |
|---|---|---|
| **Claude Code** (terminal et app Claude) | stdio | ✅ **Testé de bout en bout** : connexion réelle à un espace client EDF, dialogue d'autorisation, journal, attente du 2e facteur sur banc d'essai |
| **Claude Desktop / Cowork** | stdio | ✅ **Testé** : `sesame install` déclare le serveur, les sept outils apparaissent, appels journalisés sous le nom `cowork` |
| **Client MCP officiel** (SDK TypeScript) | Streamable HTTP | ✅ **Testé** (`npm run check`) : jeton en en-tête ou dans l'URL, liste et appel d'outils, refus sans jeton |
| Cursor, VS Code Copilot (mode agent), Windsurf | stdio | 🟡 Compatible par construction (même serveur stdio). Configuration fournie par `sesame install cursor\|vscode\|windsurf`. **Non testé.** |
| Codex CLI (OpenAI), Gemini CLI (Google) | stdio | 🟡 Compatible par construction. `sesame install codex\|gemini`. **Non testé.** |
| **ChatGPT** (connecteurs, mode développeur) | HTTP distant | 🟡 ChatGPT ne lance pas de processus local et n'atteint pas 127.0.0.1 : il faut `sesame serve` **plus un tunnel HTTPS** (cloudflared, ngrok…), URL `https://<tunnel>/mcp/<jeton>`. Possible, mais **non testé**, et à réserver à qui mesure le risque d'exposer un point d'entrée (voir SECURITY.md). |
| Autres agents (LangChain, OpenAI Agents SDK, Mistral, etc.) | l'un ou l'autre | 🟡 Tout ce qui parle MCP fonctionne en principe. Non testé. |

Voir toutes les configurations d'un coup : `sesame install print`.

## Limites connues

- **Captcha** : Sésame ne le résout pas ; il le signale (`hint`) et c'est à toi de le faire dans le Chrome.
- **Formulaires exotiques** (champs sans `type`, Shadow DOM) : indique les sélecteurs avec `--user-sel / --pass-sel / --submit-sel`. Pour les trouver : clic droit sur le champ → Inspecter.
- **macOS uniquement** (Trousseau + boîtes de dialogue `osascript`). Node ≥ 20.
- Depuis la 0.5.1, la lecture du mot de passe passe par l'assistant Trousseau signé (`sesame-keychain`), qui crée lui-même chaque élément : aucune boîte de dialogue du Trousseau pour un site enregistré désormais. Un site enregistré avant la 0.5.1 appartient encore à l'ancien outil ; `sesame doctor` le signale et `sesame migrate-keychain` corrige (une fenêtre du Trousseau, clique **Autoriser**, une fois) — voir SECURITY.fr.md.
- Un agent qui exécute du JavaScript dans le Chrome Sésame (Claude in Chrome installé dans ce profil) peut observer ce que Sésame tape dans la page. Sésame soumet toujours et vide le champ en cas d'échec, mais ne peut pas cacher le DOM à une extension que tu as installée. Voir SECURITY.fr.md.
- Par l'extension, si Chrome cesse de répondre après la remise des identifiants, Sésame répond « l'extension n'a pas répondu : vérifie l'onglet » et ne réessaie **pas** dans le Chrome dédié (le formulaire a peut-être déjà été soumis).
- Un parcours qui bascule vers un domaine que tu n'as jamais approuvé, et qui n'y montre *pas* déjà un mot de passe (un formulaire de connexion tout neuf, par exemple), se termine encore par un abandon simple — rien à proposer. Voir « Un domaine différent pour le mot de passe » plus haut.

## Dépannage

```bash
sesame doctor
```

- *« Impossible de joindre Chrome sur http://127.0.0.1:9222 »* → `sesame chrome` (le Chrome ordinaire ne suffit pas).
- *« Aucun champ identifiant/mot de passe visible »* → ouvre la page de connexion (Claude peut appeler `sesame_open_login`) ou précise `--url`.
- Claude ne voit pas les outils → redémarre Claude Desktop ; dans Claude Code, `claude mcp list` doit afficher `sesame`.
- Fichiers : `~/.sesame/sites.json` (config), `~/.sesame/journal.jsonl` (journal), `~/.sesame/LOCKED` (Bloquer), `~/.sesame/chrome-profile/`.

## Sécurité — résumé

- Secrets : Trousseau macOS uniquement, chiffré par le système, lié à ta session.
- Claude : aucune API ne renvoie un secret ; les erreurs sont assainies.
- Contrôle : politique par site, validation par dialogue (défaut), révocation, Bloquer global.
- Traçabilité : journal append-only, lisible par toi et par Claude.
- Périmètre : tout tourne en local sur le Mac ; aucun réseau sortant sauf Chrome lui-même.
