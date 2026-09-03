// Construit dist/ : index.html complet (doctype, en-tête, favicon) à partir du fragment index.html.
import fs from "node:fs";
const frag = fs.readFileSync("index.html", "utf8");
const title = (frag.match(/<title>(.*?)<\/title>/) || [, "Sésame"])[1];
const body = frag.replace(/<title>.*?<\/title>\s*/, "");
const favicon = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 3C46 14 54 27 54 41c0 13-10 20-22 20S10 54 10 41c0-14 8-27 22-38z" fill="#C48A22"/><path fill-rule="evenodd" d="M32 24a7 7 0 1 1 0 14 7 7 0 1 1 0-14zm-2.6 12h5.2l2.4 12h-10z" fill="#1A1714"/></svg>');
const head = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} — vos mots de passe restent chez vous, Claude fait le reste</title>
<meta name="description" content="Sésame ouvre vos comptes à la place de Claude, sans jamais lui montrer un identifiant. Local, chiffré dans le Trousseau macOS, vous validez chaque accès. Gratuit.">
<meta property="og:title" content="Sésame">
<meta property="og:description" content="Vos mots de passe restent chez vous. Claude fait le reste.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://sesamekey.app/">
<link rel="icon" href="${favicon}">
<link rel="canonical" href="https://sesamekey.app/">
<style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
`;
fs.mkdirSync("dist/img", { recursive: true });
for (const f of fs.readdirSync("img")) fs.copyFileSync("img/" + f, "dist/img/" + f);
fs.writeFileSync("dist/index.html", head + body + "\n</body>\n</html>\n");
fs.copyFileSync("privacy.html", "dist/privacy.html"); // page de confidentialité (déjà un document complet) : requise par le Chrome Web Store
fs.writeFileSync("dist/_headers", "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n");
console.log("dist/index.html", fs.statSync("dist/index.html").size, "octets");
console.log("dist/privacy.html", fs.statSync("dist/privacy.html").size, "octets");
