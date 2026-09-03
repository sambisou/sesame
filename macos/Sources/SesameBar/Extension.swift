import Foundation
import AppKit
import SwiftUI
import Darwin

/// État de l'extension Chrome vue depuis le Mac : manifeste de messagerie native, pont joignable, extension connectée.
struct ExtensionStatus: Equatable {
    var manifest = false          // ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/app.sesamekey.bridge.json
    var manifestId: String?       // ID de l'extension autorisée dans le manifeste
    var bridge = false            // ~/.sesame/bridge.sock répond au ping
    var connected = false         // le pont a une extension en face
    var version: String?

    var level: Int { connected ? 3 : bridge ? 2 : manifest ? 1 : 0 }
    var label: String {
        switch level {
        case 3: return "Extension Chrome connectée" + (version.map { " · \($0)" } ?? "")
        case 2: return "Pont prêt, extension pas encore connectée"
        case 1: return "Extension déclarée, Chrome ne l'a pas encore chargée"
        default: return "Extension Chrome non installée"
        }
    }
}

enum ChromeExtension {
    static let bridgeName = "app.sesamekey.bridge"
    static var manifestPath: String {
        NSHomeDirectory() + "/Library/Application Support/Google/Chrome/NativeMessagingHosts/\(bridgeName).json"
    }

    /// Lit l'état complet (à appeler hors du thread principal : la socket peut attendre jusqu'à une seconde).
    static func probe(socketPath: String) -> ExtensionStatus {
        var st = ExtensionStatus()
        if let d = try? Data(contentsOf: URL(fileURLWithPath: manifestPath)),
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            st.manifest = true
            if let origins = o["allowed_origins"] as? [String], let first = origins.first {
                st.manifestId = first.replacingOccurrences(of: "chrome-extension://", with: "").replacingOccurrences(of: "/", with: "")
            }
        }
        if let reply = ping(socketPath) {
            st.bridge = (reply["ok"] as? Bool) ?? true
            st.connected = (reply["extension"] as? Bool) ?? false
            st.version = reply["version"] as? String
        }
        return st
    }

    /// Ping JSON sur la socket Unix du pont, une ligne aller, une ligne retour, une seconde au plus.
    static func ping(_ path: String) -> [String: Any]? {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var tv = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.baseAddress!.copyMemory(from: bytes, byteCount: bytes.count)
            raw[bytes.count] = 0
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, len) } }
        guard rc == 0 else { return nil }
        let req = Array("{\"type\":\"ping\"}\n".utf8)
        guard write(fd, req, req.count) == req.count else { return nil }
        var buf = [UInt8](repeating: 0, count: 4096)
        var got = Data()
        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            got.append(contentsOf: buf[0..<n])
            if got.contains(10) { break }
            if got.count > 65536 { break }
        }
        guard let nl = got.firstIndex(of: 10) else { return nil }
        return (try? JSONSerialization.jsonObject(with: got[got.startIndex..<nl])) as? [String: Any]
    }

    /// Où est installé Sésame (le dépôt) ? Via la commande `sesame` de l'utilisateur (npm link ou alias).
    static func repoRoot() -> String? {
        let out = shell("p=$(command -v sesame) && [ -n \"$p\" ] && realpath \"$p\"")
        guard let real = out?.trimmingCharacters(in: .whitespacesAndNewlines), !real.isEmpty else {
            // Repli : le dépôt téléchargé au chemin habituel.
            let guess = NSHomeDirectory() + "/Downloads/sesame"
            return FileManager.default.fileExists(atPath: guess + "/bin/sesame.js") ? guess : nil
        }
        // …/sesame/bin/sesame.js → …/sesame
        return URL(fileURLWithPath: real).deletingLastPathComponent().deletingLastPathComponent().path
    }

    static func extensionDir() -> String? {
        guard let root = repoRoot() else { return nil }
        let dir = root + "/extension"
        return FileManager.default.fileExists(atPath: dir + "/manifest.json") ? dir : nil
    }

    /// Lance `sesame install extension --id …` avec le PATH de l'utilisateur ; renvoie la sortie.
    static func install(id: String) -> (ok: Bool, output: String) {
        guard id.range(of: #"^[a-p]{32}$"#, options: .regularExpression) != nil else {
            return (false, "L'ID d'une extension Chrome fait 32 lettres entre a et p (copie-le sous le nom de l'extension dans chrome://extensions).")
        }
        let cmd = "sesame install extension --id \(id)"
        let r = shellFull(cmd)
        return (r.status == 0, r.output.isEmpty ? (r.status == 0 ? "Pont déclaré." : "Échec (code \(r.status)).") : r.output)
    }

    static func openChromeExtensionsPage() {
        _ = shellFull("open -a 'Google Chrome' 'chrome://extensions/'")
    }

    static func revealExtensionDir() {
        guard let dir = extensionDir() else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: dir)])
    }

    // MARK: shell (zsh de connexion : même PATH que le Terminal de l'utilisateur)
    private static func shell(_ cmd: String) -> String? {
        let r = shellFull(cmd); return r.status == 0 ? r.output : nil
    }
    private static func shellFull(_ cmd: String) -> (status: Int32, output: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", cmd]
        let out = Pipe(); p.standardOutput = out; p.standardError = out
        do { try p.run() } catch { return (-1, error.localizedDescription) }
        p.waitUntilExit()
        let s = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (p.terminationStatus, s.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

/// Fenêtre d'installation guidée de l'extension Chrome : trois étapes, l'app fait le reste.
struct ExtensionSetupView: View {
    let store: Store
    @State private var id = ""
    @State private var output: String?
    @State private var busy = false
    @State private var extDir: String? = ChromeExtension.extensionDir()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(nsImage: SeedIcon.appIcon(size: 64)).resizable().frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Extension Chrome").font(.system(size: 14, weight: .semibold))
                    Text("Pour que Sésame remplisse vos identifiants dans votre Chrome habituel, sans fenêtre à part.").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }

            statusLine

            step(1, "Ouvrez la page des extensions de Chrome et activez le « Mode développeur » (en haut à droite).") {
                Button("Ouvrir chrome://extensions") { ChromeExtension.openChromeExtensionsPage() }
            }
            step(2, "Cliquez « Charger l'extension non empaquetée » et choisissez le dossier « extension » de Sésame.") {
                if extDir != nil { Button("Afficher le dossier dans le Finder") { ChromeExtension.revealExtensionDir() } }
                else { Text("Dossier introuvable : la commande « sesame » n'est pas installée. Relancez « Install Sesame.command ».").font(.system(size: 11)).foregroundStyle(Color(red: 0.7, green: 0.23, blue: 0.18)) }
            }
            step(3, "Copiez l'ID affiché sous « Sésame » dans la liste des extensions, collez-le ici, puis rechargez l'extension (bouton ↻).") {
                HStack(spacing: 8) {
                    TextField("", text: $id, prompt: Text("32 lettres, ex. abcdefghijklmnopabcdefghijklmnop")).textFieldStyle(.roundedBorder).font(.system(size: 11, design: .monospaced)).frame(width: 300)
                    Button(busy ? "…" : "Relier") { link() }.disabled(busy || id.count != 32).buttonStyle(.borderedProminent)
                }
            }
            if let o = output { Text(o).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(6) }

            Text("À savoir : l'extension tape le mot de passe dans une page de votre Chrome de tous les jours. Une autre extension ayant accès à cette page pourrait l'observer, comme elle pourrait vous observer le taper. Le Chrome Sésame séparé n'a pas cette exposition. Les deux restent disponibles ; Sésame prend l'extension quand elle répond, sinon le Chrome séparé.")
                .font(.system(size: 10.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(width: 520)
        .onAppear { if let mid = store.extensionStatus.manifestId, id.isEmpty { id = mid } }
    }

    private var statusLine: some View {
        let st = store.extensionStatus
        return HStack(spacing: 8) {
            Circle().fill(st.level == 3 ? Color(red: 0.18, green: 0.48, blue: 0.31) : st.level > 0 ? Color(red: 0.85, green: 0.58, blue: 0.15) : Color.secondary.opacity(0.4)).frame(width: 8, height: 8)
            Text(st.label).font(.system(size: 12, weight: .medium))
            Spacer()
            if st.level == 3 { Text("Rien d'autre à faire.").font(.system(size: 11)).foregroundStyle(.secondary) }
        }
        .padding(10).background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
    }

    private func step<V: View>(_ n: Int, _ text: String, @ViewBuilder _ action: () -> V) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(n)").font(.system(size: 13, weight: .bold)).foregroundStyle(Color(red: 0.77, green: 0.54, blue: 0.13)).frame(width: 16)
            VStack(alignment: .leading, spacing: 6) {
                Text(text).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                action()
            }
        }
    }

    private func link() {
        busy = true
        let value = id.trimmingCharacters(in: .whitespacesAndNewlines)
        DispatchQueue.global(qos: .userInitiated).async {
            let r = ChromeExtension.install(id: value)
            DispatchQueue.main.async {
                output = r.output
                busy = false
                store.refreshExtension()
            }
        }
    }
}
