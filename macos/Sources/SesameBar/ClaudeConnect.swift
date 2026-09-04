import Foundation
import AppKit

/// Détection et connexion à Claude Desktop / Claude Code, depuis l'app — sans jamais ouvrir de terminal.
/// Utilisé par le parcours d'accueil (Onboarding.swift), les Réglages et le diagnostic du panneau.
enum ClaudeConnect {
    struct Status: Equatable {
        var desktopInstalled = false
        var codeInstalled = false
        var desktopDeclared = false
        var codeDeclared = false
        /// Claude Desktop tourne déjà, mais avec une configuration antérieure à la déclaration de Sésame :
        /// il faut le redémarrer pour qu'il la relise.
        var desktopNeedsRestart = false

        var anyInstalled: Bool { desktopInstalled || codeInstalled }
        var anyDeclared: Bool { desktopDeclared || codeDeclared }
        /// Rien à réparer : au moins une cible déclarée et à jour.
        var connected: Bool {
            (desktopInstalled && desktopDeclared && !desktopNeedsRestart) || (codeInstalled && codeDeclared)
        }
        /// Déjà déclaré partout où c'est possible, mais Claude Desktop tourne encore avec l'ancienne config.
        var needsRestartOnly: Bool {
            !connected && desktopInstalled && desktopDeclared && desktopNeedsRestart && !(codeInstalled && codeDeclared)
        }
    }

    // MARK: détection — à appeler hors du thread principal (fichiers + `claude mcp list` + `ps`)

    static func probe() -> Status {
        var st = Status()
        st.desktopInstalled = desktopAppPath() != nil

        if let cfgPath = desktopConfigPath(),
           let data = try? Data(contentsOf: URL(fileURLWithPath: cfgPath)),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let servers = obj["mcpServers"] as? [String: Any] {
            st.desktopDeclared = servers["sesame"] != nil
            if st.desktopDeclared, let running = runningClaudeDesktop(),
               let attrs = try? FileManager.default.attributesOfItem(atPath: cfgPath),
               let cfgMTime = attrs[.modificationDate] as? Date,
               let started = processStartDate(pid: running.processIdentifier),
               cfgMTime > started {
                st.desktopNeedsRestart = true
            }
        }

        st.codeInstalled = shellFull("command -v claude").status == 0
        if st.codeInstalled {
            let r = shellFull("claude mcp list")
            st.codeDeclared = r.status == 0 && r.output.contains("sesame")
        }
        return st
    }

    private static func desktopAppPath() -> String? {
        for p in ["/Applications/Claude.app", NSHomeDirectory() + "/Applications/Claude.app"] {
            if FileManager.default.fileExists(atPath: p) { return p }
        }
        return nil
    }

    private static func desktopConfigPath() -> String? {
        let p = NSHomeDirectory() + "/Library/Application Support/Claude/claude_desktop_config.json"
        return FileManager.default.fileExists(atPath: p) ? p : nil
    }

    private static func runningClaudeDesktop() -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first { $0.localizedName == "Claude" && ($0.bundleURL?.path.hasSuffix("Claude.app") ?? false) }
    }

    /// Heure de lancement du processus, via `ps` (NSRunningApplication n'expose pas cette date).
    private static func processStartDate(pid: pid_t) -> Date? {
        let out = shellFull("ps -o lstart= -p \(pid)").output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !out.isEmpty else { return nil }
        let collapsed = out.replacingOccurrences(of: " +", with: " ", options: .regularExpression)
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE MMM d HH:mm:ss yyyy"
        return f.date(from: collapsed)
    }

    // MARK: actions

    /// `sesame install all` : le lanceur embarqué du bundle si présent (cas normal, app installée depuis le
    /// .dmg), sinon la commande `sesame` de l'utilisateur (npm link / alias posés par install.sh), sinon le
    /// dépôt de développement trouvé par ChromeExtension.repoRoot().
    static func installAll() -> (ok: Bool, output: String) {
        if let launcher = bundleLauncherPath() {
            let r = shellFull("\"\(launcher)\" install all")
            return (r.status == 0, r.output)
        }
        let r = shellFull("sesame install all")
        if r.status == 0 { return (true, r.output) }
        if let root = ChromeExtension.repoRoot() {
            let r2 = shellFull("node \"\(root)/bin/sesame.js\" install all")
            return (r2.status == 0, r2.output)
        }
        return (false, r.output)
    }

    private static func bundleLauncherPath() -> String? {
        guard let exe = Bundle.main.executableURL else { return nil }
        let p = exe.deletingLastPathComponent().appendingPathComponent("sesame-launcher").path
        return FileManager.default.fileExists(atPath: p) ? p : nil
    }

    /// Quitte puis relance Claude Desktop : la manière la plus fiable de lui faire relire sa configuration.
    /// Sans effet si Claude Desktop n'est pas installé ou pas lancé.
    static func restartDesktop() {
        _ = shellFull(#"osascript -e 'tell application "Claude" to quit' >/dev/null 2>&1"#)
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1.5) {
            _ = shellFull("open -a Claude")
        }
    }

    static let downloadURL = URL(string: "https://claude.ai/download")!

    // MARK: shell (zsh de connexion : même PATH que le Terminal de l'utilisateur)
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
