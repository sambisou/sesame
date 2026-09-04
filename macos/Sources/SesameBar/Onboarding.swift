import SwiftUI
import AppKit

/// Fenêtre d'accueil, affichée une seule fois à la première ouverture (marqueur ~/.sesame/onboarded, voir
/// Store.checkFirstRun). Trois écrans : ce que fait Sésame, la connexion à Claude, le choix du navigateur.
/// Après « Terminer », Windows ouvre directement la fenêtre d'ajout de site (voir Windows.showOnboarding).
struct OnboardingView: View {
    let store: Store
    let onFinished: () -> Void

    @State private var screen = 0
    @State private var claude = ClaudeConnect.Status()
    @State private var checked = false
    @State private var connecting = false
    @State private var connectOutput: String?
    @State private var restarting = false

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Palette.seed).frame(height: 3)
            VStack(alignment: .leading, spacing: 16) {
                header
                Group {
                    switch screen {
                    case 0: welcomeScreen
                    case 1: connectScreen
                    default: browserScreen
                    }
                }
            }
            .padding(24)
            .frame(width: 480, alignment: .leading)
            dots.padding(.bottom, 16)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { refreshClaude() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(nsImage: SeedIcon.appIcon(size: 64)).resizable().frame(width: 30, height: 30)
            Text("Sésame").font(.system(size: 15, weight: .semibold))
        }
    }

    private var dots: some View {
        HStack(spacing: 6) {
            ForEach(0..<3) { i in
                Circle().fill(i == screen ? Palette.seed : Palette.muted.opacity(0.3)).frame(width: 6, height: 6)
            }
        }
    }

    // MARK: écran 1 — bienvenue

    private var welcomeScreen: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(t("onboarding_welcome_title")).font(.system(size: 18, weight: .semibold))
            Text(t("onboarding_welcome_body")).font(.system(size: 12.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button(t("onboarding_get_started")) { screen = 1 }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
        }
    }

    // MARK: écran 2 — connecter Claude

    private var connectScreen: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(t("onboarding_connect_title")).font(.system(size: 18, weight: .semibold))
            Text(t("onboarding_connect_subtitle")).font(.system(size: 12.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)

            if !checked {
                ProgressView().controlSize(.small)
            } else if !claude.anyInstalled {
                VStack(alignment: .leading, spacing: 10) {
                    Text(t("onboarding_connect_not_found")).font(.system(size: 12)).foregroundStyle(Palette.no)
                    HStack {
                        Button(t("onboarding_connect_download")) { NSWorkspace.shared.open(ClaudeConnect.downloadURL) }
                        Button(t("onboarding_connect_retry")) { refreshClaude() }
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    if claude.desktopInstalled { targetRow(t("onboarding_target_desktop"), declared: claude.desktopDeclared, needsRestart: claude.desktopNeedsRestart) }
                    if claude.codeInstalled { targetRow(t("onboarding_target_code"), declared: claude.codeDeclared, needsRestart: false) }
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))

                if let o = connectOutput { Text(o).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(4) }

                HStack {
                    if claude.connected {
                        Label(t("onboarding_target_connected"), systemImage: "checkmark.circle.fill").font(.system(size: 12)).foregroundStyle(Palette.ok)
                    } else {
                        Button(connecting ? t("onboarding_connect_working") : t("onboarding_connect_button")) { connect() }
                            .buttonStyle(.borderedProminent).disabled(connecting)
                    }
                    if claude.desktopInstalled && claude.desktopDeclared {
                        Button(restarting ? "…" : t("onboarding_restart_button")) { restart() }.disabled(restarting)
                    }
                }
            }

            HStack {
                Button(t("onboarding_back")) { screen = 0 }
                Spacer()
                Button(t("onboarding_continue")) { screen = 2 }.buttonStyle(.borderedProminent)
            }
        }
    }

    private func targetRow(_ name: String, declared: Bool, needsRestart: Bool) -> some View {
        HStack(spacing: 8) {
            Circle().fill(declared && !needsRestart ? Palette.ok : declared ? Palette.wait : Palette.muted.opacity(0.4)).frame(width: 7, height: 7)
            Text(name).font(.system(size: 12, weight: .medium))
            Spacer()
            Text(declared ? (needsRestart ? t("onboarding_target_restart") : t("onboarding_target_connected")) : t("onboarding_target_found"))
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }

    // MARK: écran 3 — navigateur

    private var browserScreen: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(t("onboarding_browser_title")).font(.system(size: 18, weight: .semibold))
            Text(t("onboarding_browser_subtitle")).font(.system(size: 12.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 8) {
                Text(t("onboarding_browser_dedicated_title")).font(.system(size: 12)).foregroundStyle(.secondary)
                Button(t("onboarding_browser_dedicated_button")) { store.openChrome() }.buttonStyle(.borderedProminent)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(t("onboarding_browser_extension_title")).font(.system(size: 12)).foregroundStyle(.secondary)
                Button(t("onboarding_browser_extension_button")) { Windows.shared.showExtensionSetup(store: store) }
            }

            HStack {
                Button(t("onboarding_back")) { screen = 1 }
                Spacer()
                Button(t("onboarding_finish")) { onFinished() }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
        }
    }

    // MARK: actions

    private func refreshClaude() {
        DispatchQueue.global(qos: .userInitiated).async {
            let st = ClaudeConnect.probe()
            DispatchQueue.main.async { claude = st; checked = true }
        }
    }

    private func connect() {
        connecting = true
        DispatchQueue.global(qos: .userInitiated).async {
            let r = ClaudeConnect.installAll()
            DispatchQueue.main.async {
                connecting = false
                connectOutput = r.output
                refreshClaude()
            }
        }
    }

    private func restart() {
        restarting = true
        ClaudeConnect.restartDesktop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            restarting = false
            refreshClaude()
        }
    }
}
