# Site sesamekey.app — multilingue

## Structure

- `template.html` — gabarit unique de la page d'accueil, avec des marqueurs
  `{{clé.pointée}}` à la place de tout texte visible. Aucun texte en dur
  (hormis le nom « Sésame », qui ne se traduit jamais, et quelques valeurs
  d'exemple neutres : `edf`, noms de domaine).
- `i18n/<code>.json` — un dictionnaire par langue (`en.json`, `fr.json`, …).
  `en.json` est la langue par défaut, servie à la racine `/`. `fr.json` est
  la référence de sens (contenu d'origine).
- `i18n/privacy.<code>.html` — version traduite de la page de confidentialité
  (document HTML complet, pas un gabarit). `privacy.html` à la racine du
  dépôt est la version anglaise, document principal.
- `build.mjs` — lit `template.html` + chaque `i18n/<code>.json` présent et
  écrit `dist/index.html` (anglais, racine) et `dist/<code>/index.html` pour
  chaque autre langue traduite. Une langue sans fichier JSON n'est
  simplement pas construite : pas besoin de traduire les 8 langues d'un
  coup.

## Ajouter une langue

1. Copier `i18n/en.json` vers `i18n/<code>.json` (`de`, `es`, `it`, `pt`,
   `nl`, `ja`…) et traduire toutes les valeurs. Garder les clés identiques,
   garder les fragments HTML inline (`<code>`, `<b>`, `<em>`, liens) tels
   quels, et garder « Sésame » non traduit partout où il apparaît.
   `flow.langNote` doit exister (c'est la note « L'app est en français pour
   l'instant » — traduite dans la langue de la page).
2. (Optionnel) Traduire la page de confidentialité : copier `privacy.html`
   vers `i18n/privacy.<code>.html`, traduire le contenu, mettre à jour
   `lang`, `canonical`, `og:url`, `og:locale` et les liens vers la page
   d'accueil (`/<code>/`) dans ce fichier.
3. La langue est déjà déclarée dans la table `LANGS` de `build.mjs` (code,
   libellé du sélecteur, `hreflang`, `og:locale`, préfixe d'URL) — rien à y
   toucher pour les 8 langues visées. Pour une langue hors de cette liste,
   ajouter une ligne à `LANGS`.
4. `node build.mjs`. La page apparaît dans `dist/<code>/index.html`, le
   sélecteur de langue de la nav l'affiche automatiquement, et les balises
   `hreflang` la pointent déjà (elles sont posées pour les 8 langues dès
   maintenant, traduites ou non).
5. Si une clé manque dans le dictionnaire, le build s'arrête avec la liste
   exacte des clés absentes — pas de page à moitié traduite en silence.

## Ce qui ne se traduit pas

- Le nom du produit, « Sésame », partout où il apparaît dans une phrase.
- Les noms de marques tierces (OVH, EDF, Claude, Chrome…) et les noms de
  domaine d'exemple.
- Les captures d'écran (`img/*.png`) : l'app elle-même n'est pas encore
  traduite. Chaque page non française affiche donc, sous « Écran par
  écran », une petite note (`flow.langNote`) qui le signale.

## Vérifier après un build

```sh
node build.mjs
grep -c '{{' dist/index.html dist/fr/index.html   # doit afficher 0 partout
```
