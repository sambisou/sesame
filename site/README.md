# Site sesamekey.app — anglais / français

## Structure

- `template.html` — gabarit unique de la page d'accueil, avec des marqueurs
  `{{clé.pointée}}` à la place de tout texte visible. Aucun texte en dur
  (hormis le nom « Sésame », qui ne se traduit jamais, et quelques valeurs
  d'exemple neutres : `edf`, noms de domaine).
- `i18n/en.json` / `i18n/fr.json` — un dictionnaire par langue. `en.json`
  est la langue par défaut, servie à la racine `/`. `fr.json` est la
  référence de sens (contenu d'origine), servie sous `/fr/`.
- `i18n/privacy.fr.html` — version française de la page de confidentialité
  (document HTML complet, pas un gabarit). `privacy.html` à la racine du
  dépôt est la version anglaise, document principal.
- `build.mjs` — lit `template.html` + `i18n/en.json` + `i18n/fr.json` et
  écrit `dist/index.html` (anglais, racine) et `dist/fr/index.html`
  (français).

Le site ne vise que ces deux langues. Pour en ajouter une autre, il
faudrait rouvrir `LANGS` dans `build.mjs`, créer `i18n/<code>.json` et
retravailler le sélecteur de langue de la nav (voir plus bas, pensé pour
deux langues) — ce n'est pas prévu à ce jour.

## Sélecteur de langue

La nav affiche deux liens sobres « EN · FR » (`{{LANG_SWITCHER}}`, généré
par `langSwitcherHtml()` dans `build.mjs`, stylé par `.langlinks` dans
`template.html`). La langue courante s'affiche en texte simple
(`aria-current="page"`), l'autre est un lien vers la racine de son
préfixe. Cliquer dessus enregistre le choix dans `localStorage` (clé
`sesame-lang`), lu par le script de redirection automatique posé sur la
page anglaise (racine) : au premier passage, si la langue du navigateur
est `fr` et qu'aucun choix n'est mémorisé, il redirige vers `/fr/`.

## Modifier le contenu

1. Éditer `i18n/en.json` et `i18n/fr.json` en gardant les clés identiques
   entre les deux fichiers, les fragments HTML inline (`<code>`, `<b>`,
   `<em>`, liens) tels quels, et « Sésame » non traduit partout où il
   apparaît.
2. `node build.mjs`. Les pages apparaissent dans `dist/index.html` et
   `dist/fr/index.html`.
3. Si une clé manque dans un dictionnaire, le build s'arrête avec la liste
   exacte des clés absentes — pas de page à moitié traduite en silence.

## Ce qui ne se traduit pas

- Le nom du produit, « Sésame », partout où il apparaît dans une phrase.
- Les noms de marques tierces (OVH, EDF, Claude, Chrome…) et les noms de
  domaine d'exemple.
- Les captures d'écran (`img/*.png`) : elles montrent l'interface en
  français (l'app suit la langue du Mac, français ou anglais, mais les
  captures ne sont prises qu'une fois). La page anglaise affiche donc,
  sous « Screen by screen », une petite note (`flow.langNote`) qui le
  signale ; la page française ne l'affiche pas.

## Vérifier après un build

```sh
node build.mjs
grep -c '{{' dist/index.html dist/fr/index.html   # doit afficher 0 partout
```
