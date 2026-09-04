import Foundation

/// Langue de l'app : celle du Mac (préférences système), anglais par défaut, français si elle commence par « fr ».
/// Aucun bundle de ressources : tout est ici, en code. Les dates relatives suivent Locale.current directement
/// (voir Panel.swift), pas cette table.
enum L10n {
    static let isFrench: Bool = (Locale.preferredLanguages.first ?? "en").lowercased().hasPrefix("fr")

    /// Chaque entrée : (français, anglais). `%@` est un point de substitution, dans l'ordre des arguments donnés à `t`.
    private static let table: [String: (fr: String, en: String)] = [
        // MARK: Panel — en-tête, sections, pied
        "panel_no_sites": ("Aucun site. Ajoute-en un ci-dessous : Claude pourra s'y connecter sans jamais voir le mot de passe.",
                            "No sites yet. Add one below: Claude will be able to sign in without ever seeing the password."),
        "panel_browser": ("Navigateur", "Browser"),
        "panel_log": ("Journal", "Log"),
        "panel_log_trailing": ("%@ dernières", "%@ most recent"),
        "panel_log_empty": ("Rien encore.", "Nothing yet."),
        "panel_subtitle_locked": ("Tout est bloqué : aucune connexion possible", "Everything is blocked: no sign-ins possible"),
        "panel_subtitle_unlocked": ("Claude se connecte tout seul, le mot de passe reste ici", "Claude signs in on its own, the password stays here"),
        "panel_lock_toggle": ("Bloquer", "Block"),
        "panel_lock_help": ("Coupe-circuit : bloque toutes les connexions, quel que soit le site, jusqu'à ce que vous le relâchiez.",
                             "Kill switch: blocks every sign-in, on any site, until you release it."),
        "site_remove_help": ("Supprimer le site et son mot de passe", "Remove the site and its password"),
        "site_remove_confirm": ("Retirer « %@ » et son mot de passe du Trousseau ?", "Remove “%@” and its password from the Keychain?"),
        "cancel": ("Annuler", "Cancel"),
        "delete": ("Supprimer", "Delete"),
        "policy_auto": ("Automatique", "Automatic"),
        "policy_ask": ("Me demander", "Ask me"),
        "policy_off": ("Coupé", "Off"),
        "add_site": ("Ajouter un site…", "Add a site…"),
        "migration_row": ("%@ site%@ à migrer pour une connexion sans fenêtre", "%@ site%@ to migrate for a window-free sign-in"),
        "migrate_button": ("Migrer…", "Migrate…"),
        "migration_report": ("%@/%@ site(s) migré(s).", "%@/%@ site(s) migrated."),
        "ext_settings": ("Réglages…", "Settings…"),
        "ext_install": ("Installer…", "Install…"),
        "ext_desc_no_ext": ("Sans extension, Sésame utilise un Chrome à part, lancé réduit, qui ne s'ouvre que pour un code.",
                             "Without the extension, Sésame uses a separate Chrome, launched minimized, that only opens for a code."),
        "ext_desc_declared": ("Chargez le dossier « extension » dans chrome://extensions, puis rechargez-la.",
                               "Load the “extension” folder in chrome://extensions, then reload it."),
        "ext_desc_bridge": ("Ouvrez Chrome (ou rechargez l'extension) pour qu'elle se connecte au pont.",
                             "Open Chrome (or reload the extension) so it connects to the bridge."),
        "footer_chrome_ready": ("Chrome Sésame prêt", "Sésame Chrome ready"),
        "footer_chrome_closed": ("Chrome Sésame fermé", "Sésame Chrome closed"),
        "open": ("Ouvrir", "Open"),
        "quit": ("Quitter", "Quit"),
        "never": ("jamais", "never"),
        "panel_settings_help": ("Réglages…", "Settings…"),
        "diag_not_connected": ("Claude n'est pas encore connecté.", "Claude isn't connected yet."),
        "diag_restart_needed": ("Redémarrez Claude pour terminer la connexion.", "Restart Claude to finish connecting."),
        "diag_repair_button": ("Réparer", "Repair"),
        "diag_restart_button": ("Redémarrer", "Restart"),

        // MARK: Panel — libellés du journal (actionLabel)
        "login_authorized": ("demande autorisée", "request authorized"),
        "login_denied": ("demande refusée", "request denied"),
        "login_success": ("connexion réussie", "signed in successfully"),
        "login_uncertain": ("connexion à vérifier", "sign-in needs checking"),
        "login_other": ("connexion : %@", "sign-in: %@"),
        "twofa_waiting": ("code demandé, attente", "code requested, waiting"),
        "twofa_accepted": ("code accepté", "code accepted"),
        "twofa_other": ("code : %@", "code: %@"),
        "site_registered": ("site enregistré", "site registered"),
        "request_other": ("enregistrement %@", "registration %@"),
        "site_removed": ("site supprimé", "site removed"),
        "policy_changed": ("règle : %@", "rule: %@"),
        "all_locked": ("tout bloqué", "everything locked"),
        "unlocked": ("blocage levé", "lock released"),
        "chrome_started": ("Chrome Sésame lancé", "Sésame Chrome launched"),
        "page_opened": ("page ouverte", "page opened"),
        "server_started": ("serveur démarré", "server started"),
        "http_started": ("HTTP démarré", "HTTP started"),
        "http_refused": ("HTTP refusé (jeton)", "HTTP refused (token)"),

        // MARK: CredentialForm
        "cred_add_title": ("Ajouter un site", "Add a site"),
        "cred_need_title": ("Claude a besoin de « %@ »", "Claude needs “%@”"),
        "cred_caller_wants": ("%@ demande à se connecter à %@", "%@ is asking to sign in to %@"),
        "cred_reason_suffix": (" — %@", " — %@"),
        "cred_subtitle_no_request": ("Vos identifiants vont dans le Trousseau macOS. Claude ne les verra jamais.",
                                      "Your credentials go into the macOS Keychain. Claude will never see them."),
        "label_name": ("Nom court", "Short name"),
        "label_login_page": ("Page de connexion", "Sign-in page"),
        "label_username": ("Identifiant", "Username"),
        "label_password": ("Mot de passe", "Password"),
        "label_note": ("Mémo (optionnel)", "Note (optional)"),
        "label_extra_domains": ("Autres domaines\n(optionnel)", "Other domains\n(optional)"),
        "placeholder_login_url": ("https://login.exemple.com/", "https://login.example.com/"),
        "placeholder_username": ("e-mail ou nom d'utilisateur", "email or username"),
        "placeholder_note": ("connexion en 2 étapes", "two-step sign-in"),
        "placeholder_extra_domains": ("séparés par des virgules, ex. exemple.com", "comma-separated, e.g. example.com"),
        "eye_hide": ("Masquer le mot de passe", "Hide the password"),
        "eye_show": ("Afficher le mot de passe", "Show the password"),
        "extra_domains_help": ("« Autres domaines » : si la connexion bascule vers un autre domaine pour le mot de passe (fournisseur d'identité séparé), l'ajouter ici l'autorise pour ce site.",
                                "“Other domains”: if the sign-in switches to another domain for the password (a separate identity provider), adding it here allows it for this site."),
        "keychain_footer": ("Enregistré dans le Trousseau, sans application de confiance : chaque lecture vous sera demandée.",
                             "Stored in the Keychain, with no trusted application: every read will prompt you."),
        "later": ("Plus tard", "Later"),
        "save": ("Enregistrer", "Save"),

        // MARK: Windows (titres de fenêtres)
        "win_add_site_title": ("Sésame — ajouter un site", "Sésame — add a site"),
        "win_extension_title": ("Sésame — extension Chrome", "Sésame — Chrome extension"),
        "win_onboarding_title": ("Sésame — bienvenue", "Sésame — welcome"),
        "win_settings_title": ("Sésame — réglages", "Sésame — settings"),

        // MARK: Onboarding.swift — accueil en trois écrans, première ouverture
        "onboarding_welcome_title": ("Bienvenue dans Sésame", "Welcome to Sésame"),
        "onboarding_welcome_body": ("Sésame garde vos mots de passe de site dans le Trousseau de votre Mac, jamais ailleurs. Claude peut alors se connecter à votre place, sans jamais voir le mot de passe. Vous choisissez, site par site, s'il doit demander à chaque fois ou agir seul.",
                                     "Sésame keeps your website passwords in your Mac's Keychain, nowhere else. Claude can then sign in on your behalf, without ever seeing the password. You choose, site by site, whether it asks every time or acts on its own."),
        "onboarding_get_started": ("Commencer", "Get Started"),
        "onboarding_connect_title": ("Connecter Claude", "Connect Claude"),
        "onboarding_connect_subtitle": ("Sésame doit se déclarer auprès de Claude pour qu'il puisse s'en servir.", "Sésame needs to register itself with Claude before it can use it."),
        "onboarding_connect_not_found": ("Claude n'est pas installé sur ce Mac.", "Claude isn't installed on this Mac."),
        "onboarding_connect_download": ("Télécharger Claude", "Download Claude"),
        "onboarding_connect_retry": ("Réessayer", "Retry"),
        "onboarding_target_desktop": ("Claude Desktop", "Claude Desktop"),
        "onboarding_target_code": ("Claude Code", "Claude Code"),
        "onboarding_target_found": ("détecté", "found"),
        "onboarding_target_connected": ("connecté ✓", "connected ✓"),
        "onboarding_target_restart": ("connecté, redémarrage nécessaire", "connected, needs a restart"),
        "onboarding_connect_button": ("Connecter", "Connect"),
        "onboarding_connect_working": ("Connexion…", "Connecting…"),
        "onboarding_restart_button": ("Redémarrer Claude", "Restart Claude"),
        "onboarding_continue": ("Continuer", "Continue"),
        "onboarding_browser_title": ("Votre navigateur", "Your browser"),
        "onboarding_browser_subtitle": ("Claude a besoin d'un Chrome pour se connecter aux sites. Choisissez maintenant, vous pourrez changer plus tard depuis le menu.",
                                         "Claude needs a Chrome to sign in to sites. Pick one now — you can change it later from the menu."),
        "onboarding_browser_dedicated_title": ("Un Chrome dédié à Sésame, rien à installer.", "A Chrome dedicated to Sésame, nothing to install."),
        "onboarding_browser_dedicated_button": ("Utiliser le Chrome Sésame", "Use the Sésame Chrome"),
        "onboarding_browser_extension_title": ("Ou votre Chrome habituel, via une extension.", "Or your everyday Chrome, via an extension."),
        "onboarding_browser_extension_button": ("Installer l'extension", "Install the extension"),
        "onboarding_back": ("Retour", "Back"),
        "onboarding_finish": ("Terminer", "Finish"),

        // MARK: Settings.swift — Réglages…
        "settings_subtitle": ("Réglages", "Settings"),
        "settings_launch_at_login": ("Démarrer Sésame à l'ouverture de session", "Start Sésame at login"),
        "settings_login_item_error": ("Impossible de changer le démarrage automatique : %@", "Couldn't change automatic startup: %@"),
        "settings_claude_title": ("Connexion à Claude", "Connection to Claude"),
        "settings_claude_desc": ("Redéclare Sésame comme serveur MCP auprès de Claude Code et Claude Desktop.", "Re-registers Sésame as an MCP server with Claude Code and Claude Desktop."),
        "settings_claude_button": ("Refaire l'installation", "Redo the install"),
        "settings_folder_title": ("Dossier de Sésame", "Sésame's folder"),
        "settings_folder_button": ("Ouvrir ~/.sesame", "Open ~/.sesame"),
        "settings_version": ("Version %@", "Version %@"),
        "settings_website": ("sesamekey.app", "sesamekey.app"),

        // MARK: Extension.swift — état et fenêtre d'installation guidée
        "ext_status_connected": ("Extension Chrome connectée", "Chrome extension connected"),
        "ext_status_bridge_ready": ("Pont prêt, extension pas encore connectée", "Bridge ready, extension not yet connected"),
        "ext_status_declared": ("Extension déclarée, Chrome ne l'a pas encore chargée", "Extension declared, Chrome hasn't loaded it yet"),
        "ext_status_not_installed": ("Extension Chrome non installée", "Chrome extension not installed"),
        "ext_id_invalid": ("L'ID d'une extension Chrome fait 32 lettres entre a et p (copie-le sous le nom de l'extension dans chrome://extensions).",
                            "A Chrome extension ID is 32 letters between a and p (copy it from under the extension's name in chrome://extensions)."),
        "ext_bridge_declared": ("Pont déclaré.", "Bridge declared."),
        "ext_install_failed": ("Échec (code %@).", "Failed (code %@)."),
        "ext_setup_title": ("Extension Chrome", "Chrome extension"),
        "ext_setup_subtitle": ("Pour que Sésame remplisse vos identifiants dans votre Chrome habituel, sans fenêtre à part.",
                                "So Sésame can fill in your credentials in your everyday Chrome, with no separate window."),
        "ext_step1": ("Ouvrez la page des extensions de Chrome et activez le « Mode développeur » (en haut à droite).",
                       "Open Chrome's extensions page and turn on “Developer mode” (top right)."),
        "ext_step1_button": ("Ouvrir chrome://extensions", "Open chrome://extensions"),
        "ext_step2": ("Cliquez « Charger l'extension non empaquetée » et choisissez le dossier « extension » de Sésame.",
                       "Click “Load unpacked” and choose Sésame's “extension” folder."),
        "ext_step2_button": ("Afficher le dossier dans le Finder", "Show the folder in Finder"),
        "ext_step2_missing": ("Dossier introuvable : la commande « sesame » n'est pas installée. Relancez « Install Sesame.command ».",
                               "Folder not found: the “sesame” command isn't installed. Rerun “Install Sesame.command”."),
        "ext_step3": ("Copiez l'ID affiché sous « Sésame » dans la liste des extensions, collez-le ici, puis rechargez l'extension (bouton ↻).",
                       "Copy the ID shown under “Sésame” in the extensions list, paste it here, then reload the extension (↻ button)."),
        "ext_step3_placeholder": ("32 lettres, ex. abcdefghijklmnopabcdefghijklmnop", "32 letters, e.g. abcdefghijklmnopabcdefghijklmnop"),
        "ext_link_button": ("Relier", "Link"),
        "ext_nothing_else": ("Rien d'autre à faire.", "Nothing else to do."),
        "ext_exposure_note": ("À savoir : l'extension tape le mot de passe dans une page de votre Chrome de tous les jours. Une autre extension ayant accès à cette page pourrait l'observer, comme elle pourrait vous observer le taper. Le Chrome Sésame séparé n'a pas cette exposition. Les deux restent disponibles ; Sésame prend l'extension quand elle répond, sinon le Chrome séparé.",
                               "Good to know: the extension types the password into a page of your everyday Chrome. Another extension with access to that page could observe it, just as it could observe you typing it. The separate Sésame Chrome doesn't have this exposure. Both stay available; Sésame uses the extension when it responds, otherwise the separate Chrome."),

        // MARK: Store.swift — erreurs affichées à l'utilisateur (lastError, addSite)
        "err_sites_unreadable": ("sites.json illisible : rien n'a été modifié.", "sites.json is unreadable: nothing was changed."),
        "err_keychain_delete_refused": ("Le Trousseau a refusé de supprimer le secret de « %@ » (code %@). Le site est conservé.",
                                         "The Keychain refused to delete the secret for “%@” (code %@). The site is kept."),
        "err_sites_write_failed": ("Impossible d'écrire sites.json : %@", "Couldn't write sites.json: %@"),
        "err_no_chrome": ("Google Chrome n'est pas dans /Applications.", "Google Chrome isn't in /Applications."),
        "err_chrome_launch_failed": ("Impossible de lancer Chrome : %@", "Couldn't launch Chrome: %@"),
        "err_name_invalid": ("Donne un nom court au site (lettres, chiffres, tirets — ex. infomaniak).",
                              "Give the site a short name (letters, digits, hyphens — e.g. infomaniak)."),
        "err_url_invalid": ("URL de la page de connexion invalide.", "Invalid sign-in page URL."),
        "err_https_required": ("La page de connexion doit être en https://.", "The sign-in page must be https://."),
        "err_password_empty": ("Le mot de passe est vide.", "The password is empty."),
        "err_internal": ("Erreur interne.", "Internal error."),
        "err_keychain_write_refused": ("Le Trousseau a refusé l'écriture (code %@). Est-il déverrouillé ?", "The Keychain refused the write (code %@). Is it unlocked?"),
        "err_saved_sites_unreadable": ("Secret enregistré, mais sites.json est devenu illisible.", "Secret saved, but sites.json became unreadable."),
        "err_saved_sites_write_failed": ("Secret enregistré mais sites.json inaccessible : %@", "Secret saved but sites.json is inaccessible: %@"),
    ]

    /// Gabarit brut (avant substitution des `%@`) dans la langue courante ; la clé elle-même si absente de la table.
    static func raw(_ key: String) -> String {
        guard let e = table[key] else { return key }
        return isFrench ? e.fr : e.en
    }
}

/// Raccourci global, comme `t(...)` côté serveur (src/i18n.js) : `t("key")` ou `t("key", arg1, arg2)`.
func t(_ key: String, _ args: String...) -> String {
    var s = L10n.raw(key)
    for a in args {
        guard let r = s.range(of: "%@") else { break }
        s.replaceSubrange(r, with: a)
    }
    return s
}
