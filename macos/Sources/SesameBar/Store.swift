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
    var lastError: String?

    let home: URL
    private var raw: [String: Any] = [:]
    private var timer: Timer?
    private let service = ProcessInfo.processInfo.environment["SESAME_KEYCHAIN_SERVICE"] ?? "sesame"

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

    private var shownRequests: Set<String> = []

    func start() {
        reload()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.reload() }
        RunLoop.main.add(timer!, forMode: .common)
    }

    // MARK: lecture

    func reload() {
        locked = FileManager.default.fileExists(atPath: lockFile.path)
        loadSites()
        loadJournal()
        checkChrome()
        heartbeat()
        pollRequests()
    }

    /// Signale au serveur MCP que l'app est là : il lui confiera alors les demandes d'identifiants
    /// (fenêtre unique avec œil) au lieu d'enchaîner des boîtes de dialogue.
    private func heartbeat() {
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? "\(ProcessInfo.processInfo.processIdentifier)\n".write(to: aliveFile, atomically: true, encoding: .utf8)
    }

    /// Demandes déposées par le serveur MCP : une fenêtre par demande, une seule fois.
    private func pollRequests() {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: requestsDir.path) else { return }
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        for n in names where n.hasSuffix(".json") && !n.hasSuffix(".done.json") {
            let id = String(n.dropLast(5))
            if shownRequests.contains(id) { continue }
            if FileManager.default.fileExists(atPath: requestsDir.appendingPathComponent(id + ".done.json").path) { continue }
            guard let d = try? Data(contentsOf: requestsDir.appendingPathComponent(n)),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let site = o["site"] as? String, let url = o["url"] as? String else { continue }
            let ts = (o["ts"] as? String).flatMap { iso.date(from: $0) } ?? Date()
            // Une demande de plus de dix minutes est périmée : le serveur a déjà rendu la main.
            if Date().timeIntervalSince(ts) > 600 { continue }
            shownRequests.insert(id)
            let r = SiteRequest(id: id, site: site, url: url, reason: o["reason"] as? String ?? "", note: o["note"] as? String,
                                caller: o["caller"] as? String ?? "Claude", ts: ts)
            Task { @MainActor in Windows.shared.showRequest(r, store: self) }
        }
    }

    /// Réponse à une demande : le serveur MCP attend ce fichier.
    func resolveRequest(_ id: String, saved: Bool) {
        let o: [String: Any] = ["status": saved ? "saved" : "refused", "ts": ISO8601DateFormatter().string(from: Date())]
        if let d = try? JSONSerialization.data(withJSONObject: o) {
            try? d.write(to: requestsDir.appendingPathComponent(id + ".done.json"), options: .atomic)
        }
    }

    private func loadSites() {
        guard let data = try? Data(contentsOf: sitesFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { raw = [:]; sites = []; return }
        raw = obj
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso2 = ISO8601DateFormatter()
        sites = obj.keys.sorted().compactMap { key in
            guard let s = obj[key] as? [String: Any] else { return nil }
            let lu = (s["lastUsed"] as? String).flatMap { iso.date(from: $0) ?? iso2.date(from: $0) }
            return Site(id: key, domain: s["domain"] as? String ?? "", loginUrl: s["loginUrl"] as? String ?? "",
                        policy: s["policy"] as? String ?? "ask", note: s["note"] as? String, lastUsed: lu)
        }
    }

    private func loadJournal() {
        guard let text = try? String(contentsOf: journalFile, encoding: .utf8) else { events = []; return }
        let lines = text.split(separator: "\n").suffix(40)
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso2 = ISO8601DateFormatter()
        var out: [Event] = []
        for (i, line) in lines.enumerated() {
            guard let d = line.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let tsS = o["ts"] as? String, let ts = iso.date(from: tsS) ?? iso2.date(from: tsS) else { continue }
            out.append(Event(id: "\(tsS)-\(i)", ts: ts, site: o["site"] as? String, action: o["action"] as? String ?? "?",
                             caller: o["caller"] as? String, result: o["result"] as? String, detail: o["detail"] as? String))
        }
        events = Array(out.reversed())
    }

    private func checkChrome() {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:9222/json/version")!)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            let up = (resp as? HTTPURLResponse)?.statusCode == 200 && data != nil
            DispatchQueue.main.async { self?.chromeUp = up }
        }.resume()
    }

    // MARK: écriture (mêmes règles que la CLI)

    private func saveSites() throws {
        let data = try JSONSerialization.data(withJSONObject: raw, options: [.prettyPrinted, .sortedKeys])
        let tmp = sitesFile.appendingPathExtension("tmp")
        try data.write(to: tmp, options: .atomic)
        _ = try FileManager.default.replaceItemAt(sitesFile, withItemAt: tmp)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: sitesFile.path)
    }

    private func log(site: String?, action: String, result: String, detail: String? = nil) {
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var o: [String: Any] = ["ts": iso.string(from: Date()), "action": action, "caller": "barre", "result": result]
        if let site { o["site"] = site }
        if let detail { o["detail"] = detail }
        guard let data = try? JSONSerialization.data(withJSONObject: o), var line = String(data: data, encoding: .utf8) else { return }
        line += "\n"
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if let h = try? FileHandle(forWritingTo: journalFile) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
        else { try? line.write(to: journalFile, atomically: true, encoding: .utf8) }
    }

    func setPolicy(_ key: String, _ policy: String) {
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
        _ = security(["delete-generic-password", "-s", service, "-a", key])
        raw.removeValue(forKey: key)
        do { try saveSites(); log(site: key, action: "remove_site", result: "ok", detail: "site et secret supprimés"); lastError = nil }
        catch { lastError = "Impossible d'écrire sites.json : \(error.localizedDescription)" }
        loadSites()
    }

    /// Enregistre un site : le secret va au Trousseau (sans application de confiance), jamais ailleurs.
    func addSite(name: String, url: String, username: String, password: String, note: String) -> String? {
        let key = Store.normalize(name)
        guard !key.isEmpty else { return "Donne un nom court au site (ex. infomaniak)." }
        guard let u = URL(string: url.trimmingCharacters(in: .whitespaces)), let host = u.host else { return "URL de la page de connexion invalide." }
        let local = ["127.0.0.1", "localhost"].contains(host)
        guard u.scheme == "https" || (local && u.scheme == "http") else { return "La page de connexion doit être en https://." }
        guard !password.isEmpty else { return "Le mot de passe est vide." }
        let existing = raw[key] as? [String: Any]
        let domain = existing?["domain"] as? String ?? Store.siteDomain(for: host)
        let payload: [String: String] = ["username": username.trimmingCharacters(in: .whitespaces), "password": password]
        guard let pd = try? JSONSerialization.data(withJSONObject: payload), let ps = String(data: pd, encoding: .utf8) else { return "Erreur interne." }
        _ = security(["delete-generic-password", "-s", service, "-a", key])
        let r = security(["add-generic-password", "-s", service, "-a", key, "-l", "Sésame — \(key)", "-D", "Identifiants Sésame (Claude)", "-T", "", "-w", ps])
        guard r.status == 0 else {
            log(site: key, action: "add_site", result: "échec", detail: "écriture Trousseau (code \(r.status))")
            return "Le Trousseau a refusé l'écriture (code \(r.status)). Est-il déverrouillé ?"
        }
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var s: [String: Any] = existing ?? [:]
        s["domain"] = domain; s["loginUrl"] = u.absoluteString; s["policy"] = existing?["policy"] as? String ?? "ask"
        if !note.isEmpty { s["note"] = note }
        if s["selectors"] == nil { s["selectors"] = [String: String]() }
        if s["createdAt"] == nil { s["createdAt"] = iso.string(from: Date()) }
        raw[key] = s
        do { try saveSites() } catch { return "Secret enregistré mais sites.json inaccessible : \(error.localizedDescription)" }
        log(site: key, action: existing == nil ? "add_site" : "update_site", result: "ok", detail: "\(domain), politique \(s["policy"] ?? "ask"), saisi dans la barre des menus")
        loadSites()
        lastError = nil
        return nil
    }

    func openChrome() {
        let chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        guard FileManager.default.fileExists(atPath: chrome) else { lastError = "Google Chrome n'est pas dans /Applications."; return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: chrome)
        p.arguments = ["--remote-debugging-port=9222", "--user-data-dir=\(chromeProfile.path)", "--no-first-run", "--no-default-browser-check", "--password-store=basic"]
        p.standardOutput = nil; p.standardError = nil
        do { try p.run(); log(site: nil, action: "chrome_start", result: "ok", detail: "port 9222, depuis la barre des menus") }
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

    static func normalize(_ name: String) -> String {
        let lowered = name.trimmingCharacters(in: .whitespaces).lowercased()
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789._-")
        var out = ""; var dash = false
        for ch in lowered {
            if allowed.contains(ch) { out.append(ch); dash = false }
            else if !dash { out.append("-"); dash = true }
        }
        return out.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    static let authLabels: Set<String> = ["login", "auth", "accounts", "account", "sso", "id", "idp", "signin", "sign-in", "connect", "oauth", "secure", "my", "mon", "espace-client", "espaceclient", "identity", "authentification", "authentication", "portal", "compte", "moncompte", "customer", "client", "www"]

    /// Même règle que src/config.js : login.x.com → x.com.
    static func siteDomain(for host: String) -> String {
        var parts = host.lowercased().split(separator: ".").map(String.init)
        if parts.first == "www" { parts.removeFirst() }
        if parts.count >= 3, let first = parts.first, authLabels.contains(first) { parts.removeFirst() }
        return parts.joined(separator: ".")
    }
}
