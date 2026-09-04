// Langue des messages destinés à l'humain (dialogues macOS, notifications, bandeau d'attente du code) :
// celle du Mac (`defaults read -g AppleLanguages`, lu une seule fois), repli sur LANG/LC_ALL, repli final
// anglais. Les messages destinés à l'IA (steps, reason, message renvoyés par login/requestSite/…) ne
// passent PAS par ce module : ils restent en français, ce sont des données pour le modèle.
import { execFileSync } from "node:child_process";

let cachedLang = null;

function detectLang() {
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("/usr/bin/defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8", timeout: 2000 });
      const m = out.match(/"?([a-zA-Z-]+)"?/);
      if (m) return m[1].toLowerCase().startsWith("fr") ? "fr" : "en";
    } catch { /* pas de préférence macOS lisible : on retombe sur l'environnement */ }
  }
  const env = String(process.env.LC_ALL || process.env.LANG || "").toLowerCase();
  return env.startsWith("fr") ? "fr" : "en";
}

/** Langue courante ("fr" ou "en"), déterminée une seule fois par processus. */
export function lang() {
  if (!cachedLang) cachedLang = detectLang();
  return cachedLang;
}

const DICT = {
  channel_extension: { fr: "votre Chrome habituel (extension Sésame)", en: "your everyday Chrome (Sésame extension)" },
  channel_chrome_profile: { fr: "le Chrome Sésame", en: "the Sésame Chrome" },

  ok_authorize: { fr: "Autoriser", en: "Allow" },
  cancel_refuse: { fr: "Refuser", en: "Deny" },
  ok_continue: { fr: "Continuer", en: "Continue" },
  cancel_cancel: { fr: "Annuler", en: "Cancel" },
  ok_register: { fr: "Enregistrer", en: "Register" },
  cancel_later: { fr: "Plus tard", en: "Later" },
  reason_label: { fr: "Motif", en: "Reason" },

  dlg_access_title: { fr: "Sésame — demande d'accès", en: "Sésame — access request" },
  dlg_access_message: {
    fr: "Claude ({caller}) demande à se connecter à « {site} » ({domain}).\n\n{reasonLine}Autoriser le remplissage des identifiants dans {channel} ?",
    en: "Claude ({caller}) is asking to sign in to “{site}” ({domain}).\n\n{reasonLine}Allow filling in the credentials in {channel}?",
  },

  dlg_new_domain_title: { fr: "Sésame — nouveau domaine", en: "Sésame — new domain" },
  dlg_new_domain_message: {
    fr: "{site} redirige vers {domain} pour le mot de passe. Autoriser ce domaine pour ce site ?",
    en: "{site} is redirecting to {domain} for the password. Allow this domain for this site?",
  },

  dlg_new_site_title: { fr: "Sésame — nouveau site", en: "Sésame — new site" },
  dlg_new_site_message: {
    fr: "Claude ({caller}) a besoin de se connecter à « {key} » ({domain}).\n\n{reasonLine}Sésame va vous demander votre identifiant puis votre mot de passe pour ce site. Ils seront rangés dans le Trousseau macOS ; Claude ne les verra jamais.\n\nEnregistrer ce site maintenant ?",
    en: "Claude ({caller}) needs to sign in to “{key}” ({domain}).\n\n{reasonLine}Sésame will ask for your username, then your password, for this site. They'll be stored in the macOS Keychain — Claude will never see them.\n\nRegister this site now?",
  },

  dlg_username_message: {
    fr: "Identifiant ou e-mail pour {domain} (laissez vide si le site n'en demande pas) :",
    en: "Username or email for {domain} (leave blank if the site doesn't ask for one):",
  },
  dlg_password_message: {
    fr: "Mot de passe pour {domain} (la frappe est masquée) :",
    en: "Password for {domain} (typing is hidden):",
  },
  dlg_confirm_password_message: { fr: "Confirmez le mot de passe :", en: "Confirm the password:" },
  dlg_password_mismatch_message: {
    fr: "Les deux saisies diffèrent. On recommence ?",
    en: "The two entries don't match. Try again?",
  },

  notif_code_title: { fr: "Sésame — code demandé", en: "Sésame — code requested" },
  notif_code_message: {
    fr: "{site} demande un code de vérification{detail}. Tapez le code reçu par e-mail, SMS ou application dans {channel}. J'attends jusqu'à {min} min.",
    en: "{site} is asking for a verification code{detail}. Type the code you received by email, SMS, or app in {channel}. I'll wait up to {min} min.",
  },
  notif_ext_no_response: {
    fr: "Connexion à {site} : l'extension n'a pas répondu, vérifie l'onglet.",
    en: "Signing in to {site}: the extension didn't respond — check the tab.",
  },
  notif_login_filled: {
    fr: "Connexion à {site} remplie pour Claude ({caller}).",
    en: "Sign-in to {site} filled in for Claude ({caller}).",
  },
  notif_login_check: {
    fr: "Connexion à {site} : à vérifier ({hint}).",
    en: "Sign-in to {site}: needs checking ({hint}).",
  },
  notif_site_registered: {
    fr: "« {key} » enregistré. Claude peut maintenant demander la connexion (avec votre accord à chaque fois).",
    en: "“{key}” registered. Claude can now ask to sign in (with your approval each time).",
  },

  banner_wait_code: {
    fr: "Sésame attend que vous saisissiez le code reçu par e-mail, SMS ou application. La connexion reprendra toute seule dès que le site l'aura accepté (encore {remaining} s).",
    en: "Sésame is waiting for you to enter the code you received by email, SMS, or app. The sign-in will continue automatically once the site accepts it ({remaining}s left).",
  },
};

/** Traduit `key` dans la langue courante (repli français si la langue courante manque), avec substitution {var}. */
export function t(key, vars = {}) {
  const entry = DICT[key];
  if (!entry) return key;
  let s = entry[lang()] || entry.fr;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
