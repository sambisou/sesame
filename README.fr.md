# Sésame — coffre d'identifiants local pour Claude

> 🇬🇧 [English README](README.md) · Site : [sesamekey.app](https://sesamekey.app) · Licence [MIT](LICENSE) · [Sécurité et signalement](SECURITY.fr.md)
>
> **Prototype personnel, fourni tel quel, sans garantie ni support.** Sésame manipule vos identifiants : lisez [SECURITY.md](SECURITY.md) avant de l'installer, et utilisez-le uniquement pour vos propres comptes, sous votre responsabilité.

Sésame permet à Claude (Cowork, Claude Code, Claude Desktop) de **se connecter à tes comptes web sans jamais connaître tes identifiants**.

Le principe : Claude ne demande pas *« donne-moi le mot de passe EDF »*, il demande à Sésame *« remplis le formulaire EDF dans l'onglet Chrome »*. Sésame lit le secret dans le **Trousseau macOS**, le tape lui-même dans la page, et renvoie à Claude uniquement *« fait / refusé / échec »*. Chaque demande est **journalisée** et, par défaut, **tu valides chaque accès** par une boîte de dialogue sur ton Mac.

```
   Claude (Cowork / Code)            Sésame (serveur MCP local)             Chrome « Sésame »
 ─────────────────────────         ──────────────────────────────         ────────────────────
 sesame_login("edf",        ──►    politique du site ? (ask/always/revoked)
   reason="facture août")          verrou global ?
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
| `sesame_request_site` | quand un site n'est pas encore enregistré : ouvre des fenêtres Sésame sur le Mac pour que **toi** tu saisisses identifiant et mot de passe (directement dans le Trousseau) | `enregistré / refusé / déjà connu` — jamais les valeurs |
| `sesame_open_login` | ouvre la page de connexion d'un site | URL |
| `sesame_journal` | lit le journal d'accès | événements |

Il **n'existe aucun outil** qui renvoie un identifiant ou un mot de passe. Les secrets ne quittent jamais le processus Sésame ↔ Trousseau ↔ Chrome, tous sur ton Mac. Les messages d'erreur sont tronqués et ne contiennent jamais de valeur de champ.

## Installation (5 minutes, sur le Mac mini)

Prérequis : macOS, Node.js ≥ 20 (`brew install node`), Google Chrome, Claude Desktop et/ou Claude Code.

```bash
unzip sesame.zip && cd sesame
bash install.sh
```

`install.sh` installe les dépendances, rend la commande `sesame` disponible, et déclare le serveur MCP dans Claude Code (`claude mcp add`) et dans Claude Desktop (`claude_desktop_config.json`, une sauvegarde `.bak-*` est faite). Redémarre Claude Desktop ensuite.

### Le Chrome « Sésame »

Depuis Chrome 136, Chrome refuse le pilotage à distance sur le profil par défaut. Sésame lance donc **un Chrome avec son propre profil** (`~/.sesame/chrome-profile`) et le port DevTools 9222 :

```bash
sesame chrome
```

Dans ce Chrome, la **première fois** : installe l'extension **Claude in Chrome** et relie-la à Claude Desktop, comme d'habitude. C'est dans *ce* Chrome que Claude naviguera et que Sésame remplira les identifiants. Les sessions (cookies) y restent : une fois connecté à EDF, tu restes connecté jusqu'à expiration, sans nouvel appel à Sésame.

> Astuce : pour le lancer automatiquement au démarrage, ajoute `sesame chrome` dans un Automator « Application » placé dans *Réglages système → Général → Ouverture*.

## L'app de la barre des menus

`Install Sesame.command` installe aussi **Sésame.app** dans la barre des menus (une petite graine). Tout se fait depuis là, sans terminal :

- voir chaque site enregistré et changer sa règle d'un clic : **Me demander**, **Automatique**, **Coupé** ;
- ajouter un site : une seule fenêtre avec identifiant, mot de passe et un œil pour l'afficher ; le secret part directement dans le Trousseau ;
- supprimer un site (et son secret), activer le **verrou** global, ouvrir le Chrome Sésame, lire les dernières lignes du journal.

Quand Claude a besoin d'un site pas encore enregistré, l'app ouvre cette même fenêtre pour toi (`sesame_request_site`). Si l'app ne tourne pas, Sésame retombe sur les boîtes de dialogue macOS.

Pour la construire toi-même : `cd macos && ./scripts/make-app.sh release` (Swift 6, macOS 14+), le bundle arrive dans `macos/build/Sésame.app`.

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

Relancer `sesame add edf` sur un site existant met à jour le secret (changement de mot de passe).

**Sans terminal :** quand Claude a besoin d'un site pas encore enregistré, il appelle `sesame_request_site`. Sésame ouvre trois petites fenêtres sur ton Mac (confirmation, identifiant, mot de passe), range tout dans le Trousseau, et Claude apprend seulement que le site est disponible.

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
| **Claude Desktop / Cowork** | stdio | ✅ **Testé** : `sesame install` déclare le serveur, les cinq outils apparaissent, appels journalisés sous le nom `cowork` |
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
- Chaque connexion déclenche la boîte de dialogue du Trousseau macOS avant la lecture du mot de passe : réponds **Autoriser**. Ne clique jamais **Toujours autoriser** (tout processus local pourrait alors lire l'élément en silence, voir SECURITY.fr.md).
- Un agent qui exécute du JavaScript dans le Chrome Sésame (Claude in Chrome installé dans ce profil) peut observer ce que Sésame tape dans la page. Sésame soumet toujours et vide le champ en cas d'échec, mais ne peut pas cacher le DOM à une extension que tu as installée. Voir SECURITY.fr.md.

## Dépannage

```bash
sesame doctor
```

- *« Impossible de joindre Chrome sur http://127.0.0.1:9222 »* → `sesame chrome` (le Chrome ordinaire ne suffit pas).
- *« Aucun champ identifiant/mot de passe visible »* → ouvre la page de connexion (Claude peut appeler `sesame_open_login`) ou précise `--url`.
- Claude ne voit pas les outils → redémarre Claude Desktop ; dans Claude Code, `claude mcp list` doit afficher `sesame`.
- Fichiers : `~/.sesame/sites.json` (config), `~/.sesame/journal.jsonl` (journal), `~/.sesame/LOCKED` (verrou), `~/.sesame/chrome-profile/`.

## Sécurité — résumé

- Secrets : Trousseau macOS uniquement, chiffré par le système, lié à ta session.
- Claude : aucune API ne renvoie un secret ; les erreurs sont assainies.
- Contrôle : politique par site, validation par dialogue (défaut), révocation, verrou global.
- Traçabilité : journal append-only, lisible par toi et par Claude.
- Périmètre : tout tourne en local sur le Mac ; aucun réseau sortant sauf Chrome lui-même.
