# Sécurité

Sésame manipule des identifiants. Voici ce qu'il garantit, ce qu'il ne garantit pas, et comment signaler un problème.

## Ce que Sésame fait

- Les identifiants sont stockés **uniquement dans le Trousseau macOS** (service `sesame`, un élément par site), chiffrés par le système. Sésame n'en garde aucune copie : ni fichier, ni cache, ni journal.
- Le serveur MCP **n'expose aucun outil qui renvoie un secret**. Les seules réponses possibles sont « fait », « refusé », « échec », la liste des sites (noms, domaines, règles) et le journal.
- Les valeurs des champs ne figurent jamais dans les messages d'erreur ; ils sont tronqués et nettoyés.
- Par défaut, **chaque accès est validé par une boîte de dialogue** sur le Mac (règle `ask`). Un coupe-circuit global (`sesame lock`) bloque tout.
- Le journal (`~/.sesame/journal.jsonl`) est en ajout seul : le serveur MCP ne dispose d'aucun outil pour l'effacer.
- Le remplissage se fait dans **un Chrome à profil dédié**, piloté localement (port DevTools 9222 sur 127.0.0.1). Rien ne transite par un serveur tiers.

## Les éléments du Trousseau n'ont aucune application de confiance

Depuis la 0.3.0, Sésame crée ses éléments du Trousseau **sans application de confiance**. Toute lecture d'un mot de passe, par Sésame ou par n'importe quel autre processus du Mac, déclenche donc la boîte de dialogue du Trousseau. Réponds **Autoriser** à chaque fois. Ne clique jamais **Toujours autoriser** : cela inscrirait `/usr/bin/security` comme application de confiance et rendrait toutes les lectures silencieuses, pour n'importe quel processus local. Les sites enregistrés avant la 0.3.0 gardent une application de confiance : `sesame doctor` les signale, réenregistre-les une fois avec `sesame add <site>` ou via la fenêtre Sésame.

## Le canal de l'extension Chrome (bêta)

L'extension Chrome optionnelle déplace la dernière étape du secret. Au lieu que Sésame tape directement dans un Chrome qu'il pilote (profil dédié, port DevTools 9222), le secret transite désormais **Sésame → processus pont local → extension → page**, dans ton Chrome **habituel, de tous les jours**. Le pont et l'extension se parlent par le canal de messagerie native de Chrome, pas par le réseau ; le secret vient toujours uniquement du Trousseau macOS et n'est toujours jamais renvoyé à Claude — l'extension ne renvoie que des étapes, une URL, et un résultat fait/refusé/échec, jamais les valeurs.

Ce qui change réellement : la page tourne désormais dans ton profil de navigation normal, à côté de tout ce que tu y as installé par ailleurs. **Toute autre extension ayant accès au DOM de cette page (la plupart des extensions à permissions larges) peut, en principe, observer ce qui s'y tape**, comme elle pourrait t'observer le taper toi-même. Le profil Chrome dédié n'a pas cette exposition, puisque rien d'autre n'y est installé. Utilise le Chrome dédié si tu veux garder cette page isolée ; utilise l'extension si rester dans ton navigateur habituel compte davantage pour toi. Les deux chemins gardent la même garantie : aucun secret n'est jamais remis au modèle d'IA.

**Ce qui protège ce canal (0.5.0) :**

- *Côté Chrome.* Le manifeste de messagerie native n'autorise qu'un seul `allowed_origins` (l'ID de ton extension) ; l'extension n'a pas d'entrée `externally_connectable`, donc aucune page web ni autre extension ne peut lui parler ; son script de contenu ne répond qu'aux messages de son propre service worker (`sender.id` vérifié) et ne relit jamais la valeur d'un champ ; rien n'est stocké (la permission `storage` porte l'état de connexion du popup et, pour une extension *non empaquetée* seulement, le nom du pont du banc d'essai — une version empaquetée ignore cette clé).
- *Authentification du pair, jamais d'après l'argv.* La socket Unix n'est **pas** un contrôle d'accès : tout processus de ta session peut la créer avant le pont et répondre au ping. Avant d'envoyer un secret, Sésame authentifie donc le pair sur le pid que le pong annonce, uniquement à partir de faits que le système rapporte sur CE pid — jamais `process.title` ni la ligne de commande qu'un processus se choisit (`ps -o command=`), que n'importe quel processus peut fixer à ce qu'il veut, y compris une fausse ligne complète « `node /chemin/vers/bin/sesame-bridge.js` » :
  1. `~/.sesame/bridge.sock` est une socket, à toi, en mode 0600 (revérifié après le reste, au cas où elle aurait été remplacée en cours de contrôle) ;
  2. `lsof` confirme que ce pid détient bien la socket (un usurpateur ne peut pas revendiquer le pid du vrai pont : celui-ci, en attente, ne détient aucune socket) ;
  3. `lsof -p <pid> -Ffn`, filtré sur l'entrée `txt` — le binaire réellement mappé dans ce pid, pas un fichier qu'il aurait simplement ouvert, et que le processus ne peut pas falsifier — montre un programme nommé `node` ;
  4. le PARENT de ce pid (`ps -o ppid=`, puis le même contrôle `lsof` « txt » sur le pid du parent — tout aussi infalsifiable) doit être un navigateur Chromium sous `/Applications/(Google Chrome|Google Chrome Canary|Chromium|Brave Browser|Arc).app/Contents/MacOS/` : c'est Chrome, jamais l'IA ni un script quelconque, qui est censé lancer ce pont ;
  5. le nouveau champ `script` du pong (un chemin absolu, annoncé par le pont lui-même) doit désigner un fichier dont le hash SHA-256 correspond à `bin/sesame-bridge.js` de ce dépôt, et dont le chemin réel est ce fichier du dépôt lui-même. **Cette étape est un contrôle de cohérence, pas une frontière** : le chemin est déclaré par le pair, et aucune vérification sur une socket ne peut lier un processus Node au script qu'il exécute réellement. Ce qui arrête vraiment un imposteur, c'est l'étape 4 — avoir été lancé par un navigateur Chromium, donc par le manifeste de messagerie native et le lanceur — et ces deux fichiers sont dans ton propre compte, voir « ce qui reste vrai ».
  Les étapes 4 et 5 ne s'assouplissent QUE sous `SESAME_TEST=1` dans **l'environnement de ce processus-ci** — jamais d'après ce que le pair dit de lui-même — réservé aux bancs d'essai (`test/bridge.mjs`, `test/extension-live.mjs`) : l'étape 4 accepte alors aussi un parent `node` (pas de Chrome dans les tests), et l'étape 5 accepte alors aussi un script situé n'importe où sous `~/.sesame` (le banc y dépose une copie) ; le contrôle de hash, lui, n'est jamais assoupli. Le premier de ces contrôles qui échoue vaut refus « pont non authentifié » : pas de repli, rien d'envoyé, journalisé comme refus. Le pont, lui, démarre avec `umask 077`, refuse de tourner si `~/.sesame` n'est pas un dossier 0700 à toi, et refuse un chemin préexistant qui n'est pas une socket ou pas à toi ; un second pont s'efface devant un pont déjà actif (il ne « refuse pas de démarrer » : il attend).
- *Une seule connexion pour tout l'échange.* Le ping, l'authentification du pid ci-dessus, le `prepare`, et le `fill` se déroulent tous sur **la même** connexion déjà ouverte à la socket — le pont accepte n'importe quel nombre de commandes sur une connexion, donc rien n'a besoin d'être rouvert entre les étapes. Cela ferme une brèche que l'ancienne conception avait : s'authentifier sur une connexion puis en ouvrir une *seconde* pour le `fill` proprement dit laissait quiconque s'emparerait de la socket entre les deux recevoir cette seconde connexion et se faire authentifier à son tour, en son nom propre. Avec une connexion unique, remplacer le chemin ensuite ne change rien (le descripteur déjà connecté continue de parler au vrai pont) ; et si ce vrai pont meurt entre-temps, le `fill` échoue net sur la connexion morte — Sésame ne se reconnecte jamais silencieusement à qui que ce soit d'autre qui répondrait sur ce chemin.
- *Protocole en deux temps.* Le secret n'est ni lu dans le Trousseau ni envoyé tant que l'extension n'a pas trouvé (ou ouvert) un onglet du site, en **https** (http accepté seulement pour 127.0.0.1/localhost), et vu un formulaire de connexion dessus. Ce premier temps rend un identifiant de tâche valable 60 secondes, pour cet onglet seulement ; le second temps (`fill`) doit le porter, et il n'est consommé qu'une fois. Un `fill` sans identifiant valide est refusé sans toucher aucune page.
- *Domaine et schéma vérifiés au dernier moment.* L'URL de l'onglet est revérifiée avant chaque frappe, et le script de contenu vérifie sa propre frame (frame principale comprise : https + hôte égal au site ou à un sous-domaine) avant d'agir. Un message qui porte un secret n'est jamais réinjecté après une navigation ; si la page part vers un autre hôte entre l'identifiant et le mot de passe, le remplissage est abandonné et le mot de passe n'est jamais tapé. Une URL de connexion qui n'est pas en https est refusée par le pont et par l'extension.
- *Pas de repli après l'envoi.* Si l'extension cesse de répondre **avant** l'envoi du secret, Sésame peut se replier sur le Chrome dédié (mode `auto`) et le dit. Si elle cesse de répondre **après**, non : la réponse dit que le formulaire a peut-être été soumis, le journal note *incertain*, et les identifiants ne sont jamais retapés ailleurs.
- *Rien de sensible dans les messages d'erreur.* Les URL de tout motif, indice ou étape sont réduites à origine + chemin (ni code OAuth, ni jeton de lien magique) avant d'atteindre le journal ou le modèle.
- Le pont ne journalise jamais de secret et ne survit pas à la fermeture de Chrome.

**Ce qui reste vrai — dit sans détour :**

- **Un programme qui tourne sous ta session macOS peut envoyer ses propres commandes `prepare`/`fill` au vrai pont légitime, exactement comme le fait Sésame.** L'authentification du pair établit que le processus de l'autre côté de la socket est bien `bin/sesame-bridge.js`, lancé par un vrai Chrome, non modifié — elle ne restreint pas, et ne peut pas restreindre, qui sur ton Mac a le droit de *parler* à ce vrai pont une fois qu'il tourne. N'importe quel processus qui s'exécute en ton nom peut ouvrir la même socket, demander à l'extension de remplir un formulaire, et (si tu approuves l'éventuelle boîte de dialogue Chrome qui apparaît) le faire taper. Ce n'est pas un défaut qu'un contrôle supplémentaire sur la socket corrigerait : une socket Unix inscriptible par ton utilisateur est par nature joignable par tout processus qui s'exécute comme toi.
- Un programme qui tourne sous ta session peut aussi remplacer `bin/sesame-bridge.sh`, ou réécrire le manifeste de messagerie native et le fichier `~/.sesame/node-path` : ce sont des fichiers ordinaires de ton compte, et Chrome exécute le lanceur sans le vérifier. Garde le dépôt hors des dossiers partagés et modifiable par toi seul (`sesame install extension` met le lanceur en 0755 et le manifeste en 0600, et n'écrit le manifeste que pour le navigateur que tu nommes).
- Une autre extension ayant accès au DOM de la page peut observer ce qui s'y tape (voir plus haut).
- **Sésame ne protège pas d'un Mac compromis, ni d'un autre programme qui tourne dans ta propre session — il protège le même périmètre que le Trousseau macOS lui-même, pas plus.** Quiconque contrôle ta session contrôle le Trousseau, le pont et Chrome ; l'authentification du pair relève la barre pour un attaquant *distant* ou *sandboxé* qui ne peut pas lancer de processus arbitraires en ton nom, mais ce n'est pas une frontière entre deux programmes ordinaires qui tournent tous deux en tant que toi.

## Ce que Sésame ne fait pas

- **Un agent qui exécute du JavaScript dans le Chrome Sésame peut observer ce que Sésame tape.** L'extension Claude in Chrome, installée dans ce profil, donne cet accès au modèle. La garantie « aucun outil ne renvoie un secret » couvre les outils MCP de Sésame, pas le DOM du navigateur. Sésame limite le risque (soumet toujours, vide le champ si la connexion échoue, ne laisse jamais un formulaire rempli non envoyé) mais ne peut pas empêcher un observateur dans la page. N'installe Claude in Chrome dans le profil Sésame que si tu acceptes cela.
- Si tu exposes `sesame serve` par un tunnel (pour un client distant comme ChatGPT), quiconque connaît l'URL et le jeton peut demander des connexions. Elles restent soumises à ton dialogue et journalisées, et aucun secret n'est renvoyé, mais c'est un point d'entrée que tu as choisi d'ouvrir. Renouvelle le jeton avec `sesame token --rotate`.

- Il ne résout pas les captchas, ne contourne pas le deuxième facteur : le code SMS, e-mail ou application est saisi par la personne, Sésame attend.
- Il ne protège pas contre un Mac déjà compromis : quiconque contrôle votre session macOS contrôle aussi le Trousseau et le Chrome Sésame.
- Le port DevTools 9222 est ouvert en local sur le profil Chrome dédié : tout processus local peut piloter ce Chrome. N'y ouvrez pas de session que vous ne confieriez pas à Sésame.
- Le modèle d'IA qui appelle Sésame reste un logiciel tiers : il peut demander des connexions inutiles. La règle `ask` et le journal existent pour ça.
- La détection des formulaires est heuristique : un site inhabituel peut échouer ou remplir un mauvais champ. Vérifiez le journal et le Chrome Sésame en cas de doute.

## Ce logiciel est fourni « tel quel »

Sésame est un projet personnel, gratuit, publié sous licence MIT, **sans garantie d'aucune sorte** et sans engagement de support. Vous l'utilisez sous votre seule responsabilité, pour vos propres comptes, dans le respect des conditions d'utilisation des sites concernés. L'auteur ne peut être tenu responsable d'une perte d'accès, d'une fuite d'identifiants ou d'un dommage lié à son usage.

## Signaler une vulnérabilité

N'ouvrez pas d'issue publique pour une faille exploitable. Utilisez l'onglet **Security → Report a vulnerability** du dépôt GitHub (signalement privé). Décrivez le scénario, la version, et si possible une reproduction. Une réponse est visée sous 14 jours, sans garantie de délai de correction.

## Bonnes pratiques pour les utilisateurs

- Gardez la règle `ask` pour tout site sensible (banque, impôts, e-mail).
- Passez en `revoked` un site que vous n'utilisez plus ; `sesame remove` supprime aussi le secret du Trousseau.
- Ne lancez `sesame chrome` que quand vous en avez besoin ; fermez-le ensuite.
- Relisez `sesame log` de temps en temps.
