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
