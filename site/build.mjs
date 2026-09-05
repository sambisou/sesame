// Construit dist/ à partir du gabarit site/template.html et des dictionnaires site/i18n/<lang>.json.
// Le site ne vise que deux langues : anglais (racine /) et français (/fr/).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.dirname(fileURLToPath(import.meta.url));
const I18N_DIR = path.join(SITE, "i18n");
const DIST_DIR = path.join(SITE, "dist");
const SITE_URL = "https://sesamekey.app";
const DEFAULT_LANG = "en";
// Adresse de l'extension sur le Chrome Web Store. Tant que la fiche n'est pas publiée, on pointe la
// recherche du Store (page réelle, jamais un lien mort) ; dès qu'on a l'identifiant de l'article,
// il suffit de le poser ici (ou dans SESAME_WEBSTORE_ID) pour que tous les boutons suivent.
const WEBSTORE_ID = process.env.SESAME_WEBSTORE_ID || "";
const WEBSTORE_URL = WEBSTORE_ID
  ? `https://chromewebstore.google.com/detail/${WEBSTORE_ID}`
  : "https://chromewebstore.google.com/search/S%C3%A9same";

// Table des deux langues visées ; le build ne génère que celles qui ont un
// site/i18n/<code>.json, mais les balises hreflang des deux sont posées
// dès maintenant.
const LANGS = [
  { code: "en", label: "EN", htmlLang: "en", ogLocale: "en_US", prefix: "" },
  { code: "fr", label: "FR", htmlLang: "fr", ogLocale: "fr_FR", prefix: "/fr" },
];

const favicon = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 3C46 14 54 27 54 41c0 13-10 20-22 20S10 54 10 41c0-14 8-27 22-38z" fill="#C48A22"/><mask id="h"><circle cx="32" cy="31" r="7" fill="#fff"/><path d="M29.4 36h5.2l2.4 12h-10z" fill="#fff"/></mask><rect width="64" height="64" fill="#1A1714" mask="url(#h)"/></svg>');

// --- charge les dictionnaires présents ---
const dicts = {};
for (const { code } of LANGS) {
  const p = path.join(I18N_DIR, `${code}.json`);
  if (fs.existsSync(p)) dicts[code] = JSON.parse(fs.readFileSync(p, "utf8"));
}
if (!dicts[DEFAULT_LANG]) throw new Error(`site/i18n/${DEFAULT_LANG}.json manquant : la langue par défaut est obligatoire.`);

// --- aplatit un objet imbriqué en clés à points : {a:{b:"x"}} -> {"a.b":"x"} ---
function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

// --- rend le gabarit {{clé}} à partir d'un dictionnaire aplati ; erreur si une clé manque ---
function renderI18n(tpl, flat, langCode) {
  const missing = [];
  const out = tpl.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (m, key) => {
    if (!(key in flat)) { missing.push(key); return m; }
    return flat[key];
  });
  if (missing.length) {
    throw new Error(`[${langCode}] clé(s) absente(s) de site/i18n/${langCode}.json : ${missing.join(", ")}`);
  }
  return out;
}

// --- lien confidentialité : vers la traduction si elle existe, sinon vers la version anglaise ---
function privacyHref(langCode, prefix) {
  if (langCode === DEFAULT_LANG) return "/privacy";
  const hasTranslation = fs.existsSync(path.join(I18N_DIR, `privacy.${langCode}.html`));
  return hasTranslation ? `${prefix}/privacy` : "/privacy";
}

function homeHref(prefix) {
  return prefix === "" ? "/" : `${prefix}/`;
}

// --- sélecteur de langue de la nav : deux liens sobres « EN | FR », langue courante non cliquable ---
function langSwitcherHtml(dict, currentCode) {
  const ariaLabel = dict.nav.langSwitcherLabel;
  const items = LANGS.map(({ code, label, prefix }) => {
    if (code === currentCode) return `<span aria-current="page">${label}</span>`;
    return `<a href="${homeHref(prefix)}" data-lang="${code}" onclick="try{localStorage.setItem('sesame-lang','${code}')}catch(e){}">${label}</a>`;
  });
  return `<div class="langlinks" role="group" aria-label="${ariaLabel}">${items.join('<span aria-hidden="true">·</span>')}</div>`;
}

// --- balises hreflang pour toutes les langues visées + x-default ---
function hreflangTags() {
  const alt = LANGS
    .map(({ htmlLang, prefix }) => `<link rel="alternate" hreflang="${htmlLang}" href="${SITE_URL}${homeHref(prefix)}">`)
    .join("\n");
  return `${alt}\n<link rel="alternate" hreflang="x-default" href="${SITE_URL}/">`;
}

// --- remplace {n}/{total} dans un format de compteur ---
function formatCount(fmt, n, total) {
  return fmt.replace("{n}", n).replace("{total}", total);
}

// --- script de redirection automatique vers la langue du navigateur, posé uniquement sur la racine (en) ---
function redirectScriptTag(availableNonDefaultCodes) {
  if (availableNonDefaultCodes.length === 0) return "";
  const avail = JSON.stringify(availableNonDefaultCodes);
  return `<script>(function(){try{if(localStorage.getItem('sesame-lang'))return;var avail=${avail};var nl=(navigator.language||"").slice(0,2).toLowerCase();if(avail.indexOf(nl)!==-1){location.replace("/"+nl+"/");}}catch(e){}})();</script>`;
}

fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST_DIR, "img"), { recursive: true });
for (const f of fs.readdirSync(path.join(SITE, "img"))) {
  fs.copyFileSync(path.join(SITE, "img", f), path.join(DIST_DIR, "img", f));
}

/** Capture localisée si elle existe (img/panneau.fr.png), sinon la capture par défaut. */
function localizeImages(html, langCode) {
  return html.replace(/\/img\/([a-z0-9-]+)\.png/g, (m, name) => {
    const localized = `${name}.${langCode}.png`;
    return fs.existsSync(path.join(SITE, "img", localized)) ? `/img/${localized}` : m;
  });
}

const template = fs.readFileSync(path.join(SITE, "template.html"), "utf8");
const availableCodes = LANGS.filter((l) => dicts[l.code]).map((l) => l.code);
const redirectCandidates = availableCodes.filter((c) => c !== DEFAULT_LANG);

let builtPages = 0;
for (const lang of LANGS) {
  const dict = dicts[lang.code];
  if (!dict) continue; // langue pas encore traduite : pas de page construite

  const flat = flatten(dict);
  flat["link.webstore"] = WEBSTORE_URL;

  // 1) marqueurs de construction (littéraux, pas des clés i18n strictes)
  let html = template;
  html = html.replaceAll("{{LANG_SWITCHER}}", langSwitcherHtml(dict, lang.code));
  html = html.replaceAll("{{PRIVACY_HREF}}", privacyHref(lang.code, lang.prefix));

  // note "l'app est en français" sous Écran par écran, sauf sur la page française elle-même
  const flowNote = lang.code === "fr" || !dict.flow.langNote
    ? ""
    : `<p class="flow-lang-note">${dict.flow.langNote}</p>`;
  html = html.replaceAll("{{FLOW_LANG_NOTE}}", flowNote);

  // compteur initial ("Étape 1 sur 4") et libellés des points du déroulé, rendus au build
  html = html.replaceAll("{{DEMO_COUNT_INITIAL}}", formatCount(dict.demo.countFormat, 1, 4));
  const stepKeys = ["step1", "step2", "step3", "step4"];
  stepKeys.forEach((key, i) => {
    const label = dict.demo.dotLabelFormat.replace("{n}", i + 1).replace("{title}", dict.demo[key].title);
    html = html.replaceAll(`{{DEMO_DOT_LABEL_${i + 1}}}`, label);
  });

  // objet injecté pour le déroulé JS des 4 étapes (window.SESAME_I18N)
  html = html.replaceAll("{{RUNTIME_I18N}}", `<script>window.SESAME_I18N=${JSON.stringify({ demo: dict.demo })};</script>`);

  // 2) contenu i18n proprement dit : {{clé.pointée}} -> texte traduit
  html = renderI18n(html, flat, lang.code);
  html = localizeImages(html, lang.code);

  const head = `<!doctype html>
<html lang="${lang.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${dict.meta.title}</title>
<meta name="description" content="${dict.meta.description}">
<meta property="og:title" content="${dict.og.title}">
<meta property="og:description" content="${dict.og.description}">
<meta property="og:type" content="website">
<meta property="og:locale" content="${lang.ogLocale}">
<meta property="og:url" content="${SITE_URL}${homeHref(lang.prefix)}">
<link rel="icon" href="${favicon}">
<link rel="canonical" href="${SITE_URL}${homeHref(lang.prefix)}">
${hreflangTags()}
${lang.code === DEFAULT_LANG ? redirectScriptTag(redirectCandidates) : ""}
<style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
`;

  const outDir = lang.prefix === "" ? DIST_DIR : path.join(DIST_DIR, lang.code);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "index.html");
  fs.writeFileSync(outPath, head + html + "\n</body>\n</html>\n");
  builtPages++;
  console.log(`dist${lang.prefix}/index.html`, fs.statSync(outPath).size, "octets");
}

// --- confidentialité : EN à la racine (document principal), copie pour chaque langue traduite ---
fs.copyFileSync(path.join(SITE, "privacy.html"), path.join(DIST_DIR, "privacy.html"));
console.log("dist/privacy.html", fs.statSync(path.join(DIST_DIR, "privacy.html")).size, "octets");
let builtPrivacy = 1;
for (const lang of LANGS) {
  if (lang.code === DEFAULT_LANG) continue;
  const p = path.join(I18N_DIR, `privacy.${lang.code}.html`);
  if (!fs.existsSync(p)) continue;
  const outDir = path.join(DIST_DIR, lang.code);
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(p, path.join(outDir, "privacy.html"));
  builtPrivacy++;
  console.log(`dist/${lang.code}/privacy.html`, fs.statSync(path.join(outDir, "privacy.html")).size, "octets");
}

fs.writeFileSync(
  path.join(DIST_DIR, "_headers"),
  "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n"
);

console.log(`\n${builtPages} page(s) construite(s) (${availableCodes.join(", ")}), ${builtPrivacy} page(s) de confidentialité.`);
