import Darwin
import Foundation
import Security

// SesameKeychain — assistant Trousseau signé pour Sésame.
//
// But : que src/keychain.js n'ait jamais besoin d'appeler /usr/bin/security (que n'importe quel script
// peut invoquer) pour un secret. Constat sur machine réelle : un élément créé PAR /usr/bin/security — même
// avec `-T <ce binaire>` dans son ACL — porte une partition « apple-tool: » ; macOS affiche quand même la
// boîte du Trousseau à la lecture par un tiers, ACL ou pas (comportement documenté depuis Sierra). La seule
// façon d'obtenir une lecture silencieuse est que l'élément soit créé PAR CE BINAIRE LUI-MÊME, via l'API
// Security (SecItemAdd), pour qu'il en devienne le propriétaire et le relise ensuite sans invite : c'est
// pourquoi cet outil sait maintenant aussi écrire et supprimer, pas seulement lire.
//
// Commandes :
//   sesame-keychain set <service> <account>   lit la valeur COMPLÈTE sur stdin (jusqu'à EOF), supprime un
//                                              éventuel élément existant (même service/compte), puis crée
//                                              l'élément (SecItemAdd) ; code 0, ou 1 avec un message d'erreur
//                                              SANS la valeur.
//   sesame-keychain delete <service> <account> supprime l'élément (SecItemDelete) ; code 0 si supprimé,
//                                              44 si absent, 1 si autre échec.
//   sesame-keychain get <service> <account>   imprime le secret BRUT sur stdout, SANS retour à la ligne ;
//                                              code 44 si l'élément est absent, 1 si refusé ou autre échec.
//   sesame-keychain has <service> <account>   ne lit AUCUNE donnée (kSecReturnAttributes seulement) ;
//                                              code 0 si présent, 44 si absent, 1 si autre échec.
//   sesame-keychain whoami                    imprime son propre chemin réel (une ligne), code 0.
//
// Aucune commande n'écrit sur stdout/stderr un message contenant la valeur du secret : en cas d'échec, le
// code de sortie est le seul signal (voir sec() dans src/keychain.js, qui applique la même règle côté
// /usr/bin/security — jamais e.message de Node, qui répéterait la ligne de commande).

let EXIT_NOT_FOUND: Int32 = 44
let EXIT_ERROR: Int32 = 1

func usageAndExit() -> Never {
    FileHandle.standardError.write(Data("usage: sesame-keychain get|has|set|delete <service> <account> | whoami\n".utf8))
    exit(EXIT_ERROR)
}

/// Chemin réel de ce binaire (symlinks résolus), pour `whoami`. `_NSGetExecutablePath` donne le chemin tel
/// qu'exécuté (peut contenir des symlinks) ; `realpath` le résout ensuite complètement.
func realExecutablePath() -> String {
    var size: UInt32 = 0
    _NSGetExecutablePath(nil, &size)
    var buf = [Int8](repeating: 0, count: Int(size))
    guard _NSGetExecutablePath(&buf, &size) == 0 else { return CommandLine.arguments[0] }
    let raw = String(cString: buf)
    var resolved = [Int8](repeating: 0, count: Int(PATH_MAX))
    guard let rp = realpath(raw, &resolved) else { return raw }
    return String(cString: rp)
}

func keychainQuery(service: String, account: String, returnData: Bool) -> CFDictionary {
    var q: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    if returnData {
        q[kSecReturnData as String] = true
    } else {
        q[kSecReturnAttributes as String] = true
    }
    return q as CFDictionary
}

func cmdGet(service: String, account: String) -> Never {
    var result: AnyObject?
    let status = SecItemCopyMatching(keychainQuery(service: service, account: account, returnData: true), &result)
    switch status {
    case errSecSuccess:
        guard let data = result as? Data else { exit(EXIT_ERROR) }
        FileHandle.standardOutput.write(data)
        exit(0)
    case errSecItemNotFound:
        exit(EXIT_NOT_FOUND)
    default:
        exit(EXIT_ERROR)
    }
}

func cmdHas(service: String, account: String) -> Never {
    var result: AnyObject?
    let status = SecItemCopyMatching(keychainQuery(service: service, account: account, returnData: false), &result)
    switch status {
    case errSecSuccess:
        exit(0)
    case errSecItemNotFound:
        exit(EXIT_NOT_FOUND)
    default:
        exit(EXIT_ERROR)
    }
}

func cmdWhoami() -> Never {
    print(realExecutablePath())
    exit(0)
}

/// Écrit un message d'erreur neutre sur stderr (jamais la valeur du secret) puis quitte avec ce code.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(EXIT_ERROR)
}

func cmdSet(service: String, account: String) -> Never {
    let value = FileHandle.standardInput.readDataToEndOfFile()
    guard !value.isEmpty else { fail("erreur : aucune valeur reçue sur l'entrée standard") }

    // Supprime un éventuel élément existant (même service/compte) : recréer plutôt que mettre à jour évite
    // de conserver une ancienne ACL (par exemple un élément créé par /usr/bin/security avec `-T`).
    let delQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
    SecItemDelete(delQuery as CFDictionary)

    let addQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecValueData as String: value,
        kSecAttrLabel as String: "Sésame — \(account)",
        kSecAttrDescription as String: "Identifiants Sésame (Claude)",
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked,
    ]
    let status = SecItemAdd(addQuery as CFDictionary, nil)
    guard status == errSecSuccess else { fail("erreur : écriture Trousseau refusée (code \(status))") }
    exit(0)
}

func cmdDelete(service: String, account: String) -> Never {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
    let status = SecItemDelete(query as CFDictionary)
    switch status {
    case errSecSuccess:
        exit(0)
    case errSecItemNotFound:
        exit(EXIT_NOT_FOUND)
    default:
        exit(EXIT_ERROR)
    }
}

let args = CommandLine.arguments
guard args.count >= 2 else { usageAndExit() }
switch args[1] {
case "get":
    guard args.count == 4 else { usageAndExit() }
    cmdGet(service: args[2], account: args[3])
case "has":
    guard args.count == 4 else { usageAndExit() }
    cmdHas(service: args[2], account: args[3])
case "set":
    guard args.count == 4 else { usageAndExit() }
    cmdSet(service: args[2], account: args[3])
case "delete":
    guard args.count == 4 else { usageAndExit() }
    cmdDelete(service: args[2], account: args[3])
case "whoami":
    cmdWhoami()
default:
    usageAndExit()
}
