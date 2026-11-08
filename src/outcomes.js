// Codes de résultat lisibles par machine (connexions robustes, étape 1).
// Toute réponse de login(), waitCode(), openLogin() et probe() porte, en plus de ses champs historiques
// (ok, message, steps, url…), un verdict `outcome` (ok | pending | fail), une cause précise `code`
// (anglais à points, stable), `retry` (ce que l'appelant peut faire) et `actor` (qui doit agir).
// Invariant : outcome === "ok" ⇔ ok === true. Un `pending.*` répond donc ok: false.
// Pour une cause nouvelle : AJOUTER un code ici plutôt que détourner un code existant.

/** @type {Record<string, { outcome: "ok"|"pending"|"fail", retry: "now"|"later"|"never"|"human", actor: "none"|"user"|"sesame"|"admin" }>} */
export const OUTCOMES = Object.freeze({
  // --- réussites ---------------------------------------------------------------------------------
  "ok.signed_in":              { outcome: "ok", retry: "never", actor: "none" },   // formulaire rempli, soumis, accepté (confidence : high | medium | low)
  "ok.already_signed_in":      { outcome: "ok", retry: "never", actor: "none" },   // session vivante trouvée (sonde : aucun secret lu)
  "ok.signed_in_after_step1":  { outcome: "ok", retry: "never", actor: "none" },   // deux étapes : session ouverte dès l'identifiant (Expedia)
  "ok.via_provider":           { outcome: "ok", retry: "never", actor: "none" },   // bouton du fournisseur cliqué, revenu connecté
  "ok.code_accepted":          { outcome: "ok", retry: "never", actor: "none" },   // waitCode : code saisi (Sam ou Sésame) et accepté
  "ok.no_code_pending":        { outcome: "ok", retry: "never", actor: "none" },   // waitCode : ni code ni formulaire, page connectée (confidence)
  "ok.probed":                 { outcome: "ok", retry: "never", actor: "none" },   // probe() : sonde exécutée, session non vivante (state dans la réponse)
  "ok.opened":                 { outcome: "ok", retry: "never", actor: "none" },   // openLogin : page ouverte ou ramenée devant, rien rempli
  // --- en attente de quelqu'un ---------------------------------------------------------------------
  "pending.second_factor":          { outcome: "pending", retry: "now", actor: "user" },   // code attendu, délai écoulé (actor: sesame si une boîte mail est configurée)
  "pending.second_factor_no_field": { outcome: "pending", retry: "now", actor: "user" },   // la page parle d'un code sans champ (choix de méthode, téléphone)
  "pending.user_approval":          { outcome: "pending", retry: "now", actor: "user" },   // réservé à l'atelier (Face ID) ; non émis ici
  // --- échecs ------------------------------------------------------------------------------------
  "fail.password_rejected":    { outcome: "fail", retry: "never", actor: "admin" },  // message d'erreur du site après soumission
  "fail.captcha":              { outcome: "fail", retry: "human", actor: "user" },   // captcha / vérification humaine
  "fail.form_unchanged":       { outcome: "fail", retry: "later", actor: "none" },   // mot de passe encore là, sans erreur ni captcha
  "fail.no_password_step":     { outcome: "fail", retry: "later", actor: "admin" },  // deux étapes : ni mot de passe, ni code, ni session
  "fail.no_form":              { outcome: "fail", retry: "later", actor: "admin" },  // ni formulaire ni session
  "fail.code_rejected":        { outcome: "fail", retry: "now",   actor: "user" },   // retour au formulaire mot de passe pendant l'attente du code
  "fail.form_still_visible":   { outcome: "fail", retry: "now",   actor: "none" },   // waitCode : formulaire affiché, aucun code attendu → sesame_login
  "fail.landed_elsewhere":     { outcome: "fail", retry: "never", actor: "user" },   // successUrl non atteint
  "fail.wrong_account":        { outcome: "fail", retry: "never", actor: "user" },   // page liée à un autre compte, rien saisi
  "fail.provider_needed":      { outcome: "fail", retry: "never", actor: "admin" },  // le site veut un fournisseur d'identité : déclarer authProvider
  "fail.provider_intervention":{ outcome: "fail", retry: "human", actor: "user" },   // le fournisseur demande quelque chose
  "fail.domain_approval":      { outcome: "fail", retry: "human", actor: "user" },   // needsDomain : domaine à autoriser
  "fail.tab_left":             { outcome: "fail", retry: "later", actor: "none" },   // onglet parti hors périmètre ou fermé
  "fail.rate_limited":         { outcome: "fail", retry: "later", actor: "none" },   // verrou d'essais de Sésame (retryAfter, human)
  "fail.locked":               { outcome: "fail", retry: "never", actor: "user" },   // verrou global (sesame lock)
  "fail.revoked":              { outcome: "fail", retry: "never", actor: "user" },   // politique revoked
  "fail.access_refused":       { outcome: "fail", retry: "never", actor: "user" },   // politique ask : refus ou sans réponse
  "fail.no_secret":            { outcome: "fail", retry: "never", actor: "admin" },  // aucun identifiant enregistré
  "fail.unknown_site":         { outcome: "fail", retry: "never", actor: "admin" },  // site inconnu
  "fail.keychain_waiting":     { outcome: "fail", retry: "later", actor: "user" },   // attente_trousseau
  "fail.browser":              { outcome: "fail", retry: "later", actor: "admin" },  // Chrome injoignable, port occupé, attache impossible
  "fail.extension":            { outcome: "fail", retry: "later", actor: "admin" },  // pont/extension injoignable, non authentifié
  "fail.uncertain":            { outcome: "fail", retry: "human", actor: "user" },   // secret parti vers l'extension sans réponse
  "fail.unexpected":           { outcome: "fail", retry: "later", actor: "admin" },  // exception non classée
});

/** Libellé court, en français, d'un code (messages à l'utilisateur, `sesame state`). */
export function codeLabel(code) {
  const LABELS = {
    "ok.signed_in": "connecté", "ok.already_signed_in": "session déjà ouverte", "ok.signed_in_after_step1": "connecté dès l'identifiant",
    "ok.via_provider": "connecté par le fournisseur", "ok.code_accepted": "code accepté", "ok.no_code_pending": "aucun code attendu",
    "ok.probed": "sondé", "ok.opened": "page ouverte",
    "pending.second_factor": "code attendu", "pending.second_factor_no_field": "code attendu (sans champ)", "pending.user_approval": "validation attendue",
    "fail.password_rejected": "mot de passe refusé", "fail.captcha": "captcha", "fail.form_unchanged": "formulaire inchangé",
    "fail.no_password_step": "pas d'étape mot de passe", "fail.no_form": "aucun formulaire", "fail.code_rejected": "code refusé",
    "fail.form_still_visible": "formulaire encore affiché", "fail.landed_elsewhere": "arrivé ailleurs", "fail.wrong_account": "mauvais compte",
    "fail.provider_needed": "fournisseur d'identité requis", "fail.provider_intervention": "intervention chez le fournisseur",
    "fail.domain_approval": "domaine à autoriser", "fail.tab_left": "onglet parti", "fail.rate_limited": "verrou d'essais",
    "fail.locked": "verrou global", "fail.revoked": "accès révoqué", "fail.access_refused": "accès refusé", "fail.no_secret": "aucun identifiant",
    "fail.unknown_site": "site inconnu", "fail.keychain_waiting": "Trousseau en attente", "fail.browser": "Chrome injoignable",
    "fail.extension": "extension injoignable", "fail.uncertain": "incertain", "fail.unexpected": "erreur inattendue",
  };
  return LABELS[code] || String(code || "?");
}

/** Codes dont un essai « compte » pour le verrou d'essais (voir src/state.js). */
export const BLOCKING_CODES = Object.freeze(["fail.captcha", "fail.password_rejected", "fail.form_unchanged", "fail.no_password_step", "fail.landed_elsewhere"]);

/**
 * Verdict complet pour un code : { outcome, code, retry, actor, ...extra }. Un code hors table est rangé
 * sous fail.unexpected (sans perdre le code demandé dans `code`, pour qu'on le voie et qu'on l'ajoute).
 * `extra` : confidence (ok seulement), retryAfter (fail.rate_limited), human (retry: human), actor (surcharge,
 * ex. pending.second_factor avec une boîte mail → sesame), errorText…
 */
export function outcome(code, extra = {}) {
  const def = OUTCOMES[code] || OUTCOMES["fail.unexpected"];
  const o = { outcome: def.outcome, code, retry: def.retry, actor: def.actor, ...extra };
  if (o.outcome !== "ok") delete o.confidence;   // la confiance ne qualifie qu'un verdict « ok »
  if (o.retry === "human" && typeof o.human !== "string") o.human = HUMAN_PATHS[code] || HUMAN_PATHS.default;
  return o;
}

/** Chemin humain par défaut (champ `human`) pour les codes `retry: human` ; l'appelant peut le préciser via `extra`. */
const HUMAN_PATHS = Object.freeze({
  "fail.captcha": "ouvre la page toi-même : sesame_open_login, passe le captcha dans le Chrome Sésame, puis sesame_wait_code si un code est demandé ; Sésame ne retente pas de lui-même aujourd'hui",
  "fail.provider_intervention": "ouvre la page toi-même : sesame_open_login, termine la connexion chez le fournisseur d'identité (compte, mot de passe ou code), puis rappelle sesame_login — la session restera ouverte",
  "fail.domain_approval": "autorise le domaine proposé dans la fenêtre Sésame (apprentissage assisté), puis rappelle sesame_login ; ou ajoute-le : sesame add <site> --extra-domain <domaine>",
  "fail.uncertain": "vérifie l'onglet dans ton Chrome habituel (extension) : le formulaire a peut-être été soumis ; ne relance pas sesame_login avant d'avoir regardé",
  default: "ouvre la page toi-même : sesame_open_login, puis sesame_wait_code si un code est demandé",
});

/**
 * Pose le verdict `code` sur un résultat existant : ses champs (message, steps, url, secondFactor…) sont
 * conservés ; outcome/code/retry/actor viennent de la table, `extra` s'y ajoute, et `ok` est aligné sur le
 * verdict (outcome === "ok" ⇔ ok === true) — c'est `ok` que lisent les anciens appelants.
 */
export function withOutcome(result, code, extra = {}) {
  const base = outcome(code, extra);
  const out = { ...(result && typeof result === "object" ? result : {}), ...base };
  out.ok = base.outcome === "ok";
  if (!out.ok) delete out.confidence;
  return out;
}

/** Vérifie l'invariant sur un résultat ; renvoie le résultat tel quel (ou le corrige si `code` manque). */
export function ensureOutcome(result, fallbackOk = "ok.signed_in", fallbackFail = "fail.unexpected") {
  if (!result || typeof result !== "object") return withOutcome({ message: "résultat absent" }, fallbackFail);
  if (!result.code || !OUTCOMES[result.code]) return withOutcome(result, result.ok ? fallbackOk : fallbackFail);
  if ((result.outcome === "ok") !== (result.ok === true)) return withOutcome(result, result.code);
  return result;
}
