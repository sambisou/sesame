import SwiftUI
import AppKit
import ServiceManagement

/// Fenêtre « Réglages… » : démarrage à l'ouverture de session, réinstallation Claude, dossier de Sésame,
/// version. Tout ce qu'un utilisateur pourrait vouloir faire une fois installé, sans jamais ouvrir de terminal.
struct SettingsView: View {
    let store: Store

    @State private var loginItemEnabled = SMAppService.mainApp.status == .enabled
    @State private var loginItemError: String?
    @State private var reinstalling = false
    @State private var reinstallOutput: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(nsImage: SeedIcon.appIcon(size: 64)).resizable().frame(width: 30, height: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sésame").font(.system(size: 14, weight: .semibold))
                    Text(t("settings_subtitle")).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Toggle(t("settings_launch_at_login"), isOn: Binding(get: { loginItemEnabled }, set: toggleLoginItem))
                    .toggleStyle(.switch)
                if let e = loginItemError { Text(e).font(.system(size: 10.5)).foregroundStyle(Palette.no) }
            }

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(t("settings_claude_title")).font(.system(size: 12, weight: .medium))
                        Text(t("settings_claude_desc")).font(.system(size: 10.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Button(reinstalling ? "…" : t("settings_claude_button")) { reinstall() }.disabled(reinstalling)
                }
                if let o = reinstallOutput { Text(o).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(4) }
            }

            Divider()

            HStack {
                Text(t("settings_folder_title")).font(.system(size: 12, weight: .medium))
                Spacer()
                Button(t("settings_folder_button")) { NSWorkspace.shared.activateFileViewerSelecting([store.home]) }
            }

            Divider()

            HStack {
                Text(t("settings_version", appVersion)).font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button(t("settings_website")) { NSWorkspace.shared.open(URL(string: "https://sesamekey.app")!) }.buttonStyle(.link).font(.system(size: 11))
            }
        }
        .padding(18)
        .frame(width: 420)
    }

    private var appVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
    }

    private func toggleLoginItem(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            loginItemError = nil
        } catch {
            loginItemError = t("settings_login_item_error", error.localizedDescription)
        }
        loginItemEnabled = SMAppService.mainApp.status == .enabled
    }

    private func reinstall() {
        reinstalling = true
        reinstallOutput = nil
        DispatchQueue.global(qos: .userInitiated).async {
            let r = ClaudeConnect.installAll()
            DispatchQueue.main.async {
                reinstalling = false
                reinstallOutput = r.output
                store.refreshClaudeStatus()
            }
        }
    }
}
