import Foundation
import Observation

/// Un site enregistré dans ~/.sesame/sites.json (jamais de secret ici : ils sont dans le Trousseau).
struct Site: Identifiable, Equatable {
    var id: String
    var domain: String
    var loginUrl: String
    var policy: String       // ask | always | revoked
    var note: String?
    var lastUsed: Date?
}

/// Une ligne du journal ~/.sesame/journal.jsonl.
struct Event: Identifiable, Equatable {
    var id: String
    var ts: Date
    var site: String?
    var action: String
    var caller: String?
    var result: String?
    var detail: String?
}

/// Lit et modifie les fichiers de Sésame, exactement comme la CLI : mêmes chemins, même Trousseau, même journal.
@Observable
final class Store {
    var sites: [Site] = []
    var events: [Event] = []
    var locked = false
    var chromeUp = false
    var extensionStatus = ExtensionStatus()
    var lastError: String?

    let home: URL
    private var raw: [String: Any] = [:]
    private var timer: Timer?
    private var heartbeatTimer: DispatchSourceTimer?
    private let service = ProcessInfo.processInfo.environment["SESAME_KEYCHAIN_SERVICE"] ?? "sesame"
    private var shownRequests: Set<String> = []

    init() {
        let env = ProcessInfo.processInfo.environment["SESAME_HOME"]
        home = URL(fileURLWithPath: env ?? (NSHomeDirectory() + "/.sesame"))
    }

    var sitesFile: URL { home.appendingPathComponent("sites.json") }
    var journalFile: URL { home.appendingPathComponent("journal.jsonl") }
    var lockFile: URL { home.appendingPathComponent("LOCKED") }
    var chromeProfile: URL { home.appendingPathComponent("chrome-profile") }
    var requestsDir: URL { home.appendingPathComponent("requests") }
    var aliveFile: URL { home.appendingPathComponent("bar.alive") }

    func start() {
        reload()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.reload() }
        RunLoop.main.add(timer!, forMode: .common)
        // Le battement de cœur vit sur sa propre file : un appel `security` un peu long sur le thread principal
        // ne doit pas faire croire au serveur que l'app a disparu.
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        t.schedule(deadline: .now(), repeating: 2)
        let alive = aliveFile, homeDir = home
        t.setEventHandler {
            try? FileManager.default.createDirectory(at: homeDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try? "\(ProcessInfo.processInfo.processIdentifier)\n".write(to: alive, atomically: true, encoding: .utf8)
        }
        t.resume()
        heartbeatTimer = t
    }

    // MARK: lecture

    func reload() {
        locked = FileManager.default.fileExists(atPath: lockFile.path)
        _ = loadSites()
        loadJournal()
        checkChrome()
        pollRequests()
        tick += 1
        if tick % 3 == 1 { refreshExtension() }   // toutes les 6 s : la sonde peut attendre jusqu'à une seconde
    }

    private var tick = 0
    private var probing = false

    /// Sonde l'extension Chrome hors du thread principal (manifeste, pont, extension).
    func refreshExtension() {
        if probing { return }
        probing = true
        let sock = home.appendingPathComponent("bridge.sock").path
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let st = ChromeExtension.probe(socketPath: sock)
            DispatchQueue.main.async {
                guard let self else { return }
                self.probing = false
                if st != self.extensionStatus { self.extensionStatus = st }
            }
        }
    }

    /// Relit sites.json. Renvoie false si le fichier existe mais est illisible (on n'écrit alors jamais par-dessus).
    @discardableResult
    private func loadSites() -> Bool {
        guard FileManager.default.fileExists(atPath: sitesFile.path) else { raw = [:]; sites = []; return true }
        guard let data = try? Data(contentsOf: sitesFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        raw = obj
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso2 = ISO8601DateFormatter()
        let next = obj.keys.sorted().compactMap { key -> Site? in
            guard let s = obj[key] as? [String: Any] else { return nil }
            let lu = (s["lastUsed"] as? String).flatMap { iso.date(from: $0) ?? iso2.date(from: $0) }
            return Site(id: key, domain: s["domain"] as? String ?? "", loginUrl: s["loginUrl"] as? String ?? "",
                        policy: s["policy"] as? String ?? "ask", note: s["note"] as? String, lastUsed: lu)
        }
        if next != sites { sites = next }
        return true
    }

    private func loadJournal() {
        guard let text = try? String(contentsOf: journalFile, encoding: .utf8) else { events = []; return }
        let lines = text.split(separator: "\n").suffix(60)
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso2 = ISO8601DateFormatter()
        var out: [Event] = []
        for (i, line) in lines.enumerated() {
            guard let d = line.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let tsS = o["ts"] as? String, let ts = iso.date(from: tsS) ?? iso2.date(from: tsS) else { continue }
            out.append(Event(id: "\(tsS)-\(i)", ts: ts, site: o["site"] as? String, action: o["action"] as? String ?? "?",
                             caller: o["caller"] as? String, result: o["result"] as? String, detail: o["detail"] as? String))
        }
        let next = Array(out.reversed())
        if next != events { events = next }
    }

    private func checkChrome() {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:9222/json/version")!)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            let up = (resp as? HTTPURLResponse)?.statusCode == 200 && data != nil
            DispatchQueue.main.async { if self?.chromeUp != up { self?.chromeUp = up } }
        }.resume()
    }

    /// Demandes déposées par le serveur MCP : une fenêtre par demande, une seule fois ; les demandes périmées sont purgées.
    private func pollRequests() {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: requestsDir.path) else { return }
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso2 = ISO8601DateFormatter()
        for n in names where n.hasSuffix(".json") {
            let file = requestsDir.appendingPathComponent(n)
            // Fichiers orphelins (serveur parti sans nettoyer) : au-delà de dix minutes, on les efface.
            if let attrs = try? FileManager.default.attributesOfItem(atPath: file.path), let m = attrs[.modificationDate] as? Date, Date().timeIntervalSince(m) > 600 {
                try? FileManager.default.removeItem(at: file); continue
            }
            if n.hasSuffix(".done.json") { continue }
            let id = String(n.dropLast(5))
            if shownRequests.contains(id) { continue }
            if FileManager.default.fileExists(atPath: requestsDir.appendingPathComponent(id + ".done.json").path) { continue }
            guard let d = try? Data(contentsOf: file),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let site = o["site"] as? String, let url = o["url"] as? String else { continue }
            let ts = (o["ts"] as? String).flatMap { iso.date(from: $0) ?? iso2.date(from: $0) } ?? Date()
            if Date().timeIntervalSince(ts) > 600 { continue }
            shownRequests.insert(id)
            let r = SiteRequest(id: id, site: site, url: url, reason: o["reason"] as? String ?? "", note: o["note"] as? String,
                                caller: o["caller"] as? String ?? "Claude", ts: ts)
            Task { @MainActor in Windows.shared.showRequest(r, store: self) }
        }
    }

    /// Réponse à une demande : le serveur MCP attend ce fichier. Idempotent : la première réponse compte.
    func resolveRequest(_ id: String, saved: Bool) {
        let done = requestsDir.appendingPathComponent(id + ".done.json")
        if FileManager.default.fileExists(atPath: done.path) { return }
        let o: [String: Any] = ["status": saved ? "saved" : "refused", "ts": ISO8601DateFormatter().string(from: Date())]
        if let d = try? JSONSerialization.data(withJSONObject: o) { try? d.write(to: done, options: .atomic) }
    }

    // MARK: écriture (mêmes règles que la CLI)

    private func saveSites() throws {
        let data = try JSONSerialization.data(withJSONObject: raw, options: [.prettyPrinted, .sortedKeys])
        let tmp = sitesFile.appendingPathExtension("tmp")
        try data.write(to: tmp, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmp.path)
        _ = try FileManager.default.replaceItemAt(sitesFile, withItemAt: tmp)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: sitesFile.path)
    }

    /// Ajout au journal en O_APPEND (plusieurs écrivains : serveur, CLI, app), jamais de ligne tronquée.
    private func log(site: String?, action: String, result: String, detail: String? = nil) {
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var o: [String: Any] = ["ts": iso.string(from: Date()), "action": action, "caller": "barre", "result": result]
        if let site { o["site"] = site }
        if let detail { o["detail"] = detail }
        guard let data = try? JSONSerialization.data(withJSONObject: o), let line = String(data: data, encoding: .utf8) else { return }
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard let f = fopen(journalFile.path, "a") else { return }
        fputs(line + "\n", f)
        fclose(f)
        chmod(journalFile.path, 0o600)
    }

    func setPolicy(_ key: String, _ policy: String) {
        guard loadSites() else { lastError = "sites.json illisible : rien n'a été modifié."; return }
        guard ["ask", "always", "revoked"].contains(policy), var s = raw[key] as? [String: Any] else { return }
        s["policy"] = policy; raw[key] = s
        do { try saveSites(); log(site: key, action: "policy", result: "ok", detail: policy); lastError = nil }
        catch { lastError = "Impossible d'écrire sites.json : \(error.localizedDescription)" }
        loadSites()
    }

    func toggleLock() {
        if locked {
            try? FileManager.default.removeItem(at: lockFile); log(site: nil, action: "unlock", result: "ok")
        } else {
            try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
            try? ISO8601DateFormatter().string(from: Date()).appending("\n").write(to: lockFile, atomically: true, encoding: .utf8)
            log(site: nil, action: "lock", result: "ok")
        }
        locked = FileManager.default.fileExists(atPath: lockFile.path)
    }

    func removeSite(_ key: String) {
        guard loadSites() else { lastError = "sites.json illisible : rien n'a été modifié."; return }
        let had = security(["find-generic-password", "-s", service, "-a", key]).status == 0
        let delStatus: Int32
        if let helper = keychainHelperPath {
            delStatus = runHelper(helper, ["delete", service, key])
        } else {
            delStatus = security(["delete-generic-password", "-s", service, "-a", key]).status
        }
        if had && delStatus != 0 {
            lastError = "Le Trousseau a refusé de supprimer le secret de « \(key) » (code \(delStatus)). Le site est conservé."
            log(site: key, action: "remove_site", result: "échec", detail: "suppression Trousseau refusée (code \(delStatus))")
            return
        }
        raw.removeValue(forKey: key)
        do { try saveSites(); log(site: key, action: "remove_site", result: "ok", detail: had ? "site et secret supprimés" : "site supprimé (aucun secret)"); lastError = nil }
        catch { lastError = "Impossible d'écrire sites.json : \(error.localizedDescription)" }
        loadSites()
    }

    /// Enregistre un site : le secret va au Trousseau, jamais ailleurs. Quand l'assistant Trousseau
    /// embarqué dans ce bundle est présent, c'est lui qui crée l'élément (voir keychainHelperPath /
    /// runHelper) : l'élément lui appartient et il pourra le relire sans invite. Sinon, repli sur
    /// `security -T ""` (aucune application de confiance : chaque lecture demande).
    func addSite(name: String, url: String, username: String, password: String, note: String) -> String? {
        let key = Store.normalize(name)
        guard !key.isEmpty, key.count <= 64, key.range(of: #"^[a-z0-9._-]+$"#, options: .regularExpression) != nil else { return "Donne un nom court au site (lettres, chiffres, tirets — ex. infomaniak)." }
        guard let u = URL(string: url.trimmingCharacters(in: .whitespaces)), let host = u.host else { return "URL de la page de connexion invalide." }
        let local = ["127.0.0.1", "localhost"].contains(host)
        guard u.scheme == "https" || (local && u.scheme == "http") else { return "La page de connexion doit être en https://." }
        guard !password.isEmpty else { return "Le mot de passe est vide." }
        guard loadSites() else { return "sites.json est illisible : rien n'a été modifié." }
        let existing = raw[key] as? [String: Any]
        let domain = existing?["domain"] as? String ?? Store.siteDomain(for: host)
        let payload: [String: String] = ["username": username.trimmingCharacters(in: .whitespaces), "password": password]
        guard let pd = try? JSONSerialization.data(withJSONObject: payload) else { return "Erreur interne." }
        let writeStatus: Int32
        if let helper = keychainHelperPath {
            writeStatus = runHelper(helper, ["set", service, key], stdin: pd)
        } else {
            guard let ps = String(data: pd, encoding: .utf8) else { return "Erreur interne." }
            _ = security(["delete-generic-password", "-s", service, "-a", key])
            writeStatus = security(["add-generic-password", "-s", service, "-a", key, "-l", "Sésame — \(key)", "-D", "Identifiants Sésame (Claude)", "-T", "", "-w", ps]).status
        }
        guard writeStatus == 0 else {
            log(site: key, action: "add_site", result: "échec", detail: "écriture Trousseau (code \(writeStatus))")
            return "Le Trousseau a refusé l'écriture (code \(writeStatus)). Est-il déverrouillé ?"
        }
        // Le Trousseau a pris quelques centaines de ms : on repart du fichier tel qu'il est maintenant.
        guard loadSites() else { return "Secret enregistré, mais sites.json est devenu illisible." }
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var s: [String: Any] = (raw[key] as? [String: Any]) ?? existing ?? [:]
        s["domain"] = s["domain"] as? String ?? domain
        s["loginUrl"] = s["loginUrl"] as? String ?? u.absoluteString
        s["policy"] = s["policy"] as? String ?? "ask"
        if !note.isEmpty { s["note"] = note }
        if s["selectors"] == nil { s["selectors"] = [String: String]() }
        if s["createdAt"] == nil { s["createdAt"] = iso.string(from: Date()) }
        raw[key] = s
        do { try saveSites() } catch { return "Secret enregistré mais sites.json inaccessible : \(error.localizedDescription)" }
        log(site: key, action: existing == nil ? "add_site" : "update_site", result: "ok", detail: "\(s["domain"] ?? domain), politique \(s["policy"] ?? "ask"), saisi dans l'app Sésame")
        loadSites()
        lastError = nil
        return nil
    }

    func openChrome() {
        let chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        guard FileManager.default.fileExists(atPath: chrome) else { lastError = "Google Chrome n'est pas dans /Applications."; return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: chrome)
        p.arguments = ["--remote-debugging-port=9222", "--user-data-dir=\(chromeProfile.path)", "--no-first-run", "--no-default-browser-check", "--password-store=basic", "about:blank"]
        p.standardOutput = nil; p.standardError = nil
        do { try p.run(); log(site: nil, action: "chrome_start", result: "ok", detail: "port 9222, depuis l'app Sésame") }
        catch { lastError = "Impossible de lancer Chrome : \(error.localizedDescription)" }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.checkChrome() }
    }

    // MARK: utilitaires

    @discardableResult
    private func security(_ args: [String]) -> (status: Int32, out: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        p.arguments = args
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        do { try p.run() } catch { return (-1, "") }
        p.waitUntilExit()
        let s = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (p.terminationStatus, s)
    }

    /// Chemin de l'assistant Trousseau embarqué dans ce bundle (à côté de SesameBar), s'il existe. Voir
    /// macos/Sources/SesameKeychain/main.swift : lui seul écrit/supprime en silence, `security` ne le peut plus.
    private var keychainHelperPath: String? {
        guard let exe = Bundle.main.executableURL else { return nil }
        let p = exe.deletingLastPathComponent().appendingPathComponent("sesame-keychain").path
        return FileManager.default.fileExists(atPath: p) ? p : nil
    }

    /// Lance l'assistant Trousseau avec les arguments donnés, en écrivant `stdin` sur son entrée standard
    /// (jamais en argv — un secret ne doit jamais apparaître dans la liste des processus). Renvoie
    /// uniquement le code de sortie : la sortie de l'assistant n'est ni lue ni journalisée ici.
    @discardableResult
    private func runHelper(_ path: String, _ args: [String], stdin: Data? = nil) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardOutput = Pipe(); p.standardError = Pipe()
        let inPipe = Pipe(); p.standardInput = inPipe
        do { try p.run() } catch { return -1 }
        if let stdin { inPipe.fileHandleForWriting.write(stdin) }
        try? inPipe.fileHandleForWriting.close()
        p.waitUntilExit()
        return p.terminationStatus
    }

    /// Identique à normalizeName (src/config.js) : minuscules, tout le reste devient un tiret.
    static func normalize(_ name: String) -> String {
        let lowered = name.trimmingCharacters(in: .whitespaces).lowercased()
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789._-")
        var out = ""; var dash = false
        for ch in lowered {
            if allowed.contains(ch) { out.append(ch); dash = false }
            else if !dash { out.append("-"); dash = true }
        }
        return out
    }

    /// Même règle que siteDomainFor (src/config.js). Suffixes à deux niveaux : on garde trois labels.
    static let twoLevelSuffixes: Set<String> = ["co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "govt.nz", "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "com.br", "com.mx", "co.za", "com.ar", "asso.fr", "gouv.fr", "com.tr", "co.in", "net.in", "org.in", "com.sg", "com.hk", "com.cn", "net.cn", "org.cn", "gov.cn", "co.kr", "or.kr", "go.kr", "com.tw", "co.il", "org.il", "com.pl", "com.ua", "com.my", "com.ph", "com.vn", "com.eg", "com.sa", "com.co", "com.pe", "com.ve", "com.uy", "co.id", "com.pk", "com.bd", "com.ng", "co.ke", "com.gh"]
    /// Hébergeurs mutualisés : chaque sous-domaine appartient à quelqu'un d'autre, on garde l'hôte entier.
    static let sharedSuffixes: Set<String> = ["github.io", "gitlab.io", "pages.dev", "workers.dev", "herokuapp.com", "netlify.app", "vercel.app", "web.app", "firebaseapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "amazonaws.com", "myshopify.com", "wordpress.com", "blogspot.com", "notion.site", "wixsite.com", "squarespace.com", "webflow.io", "glitch.me", "repl.co", "fly.dev", "onrender.com", "surge.sh", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "github.com", "gitlab.com", "sharepoint.com", "google.com", "googleusercontent.com", "live.com", "apple.com", "icloud.com"]

    static func siteDomain(for host: String) -> String {
        let h = host.lowercased()
        if h == "localhost" || h.range(of: #"^\d+\.\d+\.\d+\.\d+$"#, options: .regularExpression) != nil { return h }
        let parts = h.split(separator: ".").map(String.init)
        if parts.count <= 2 { return h }
        let last2 = parts.suffix(2).joined(separator: "."), last3 = parts.suffix(3).joined(separator: ".")
        if sharedSuffixes.contains(last2) || sharedSuffixes.contains(last3) { return h }
        return twoLevelSuffixes.contains(last2) ? last3 : last2
    }
}
