import SwiftUI
import AppKit

/// Une question posée par le serveur à l'utilisateur (~/.sesame/asks/<id>.json) : « Claude demande à se
/// connecter à « edf » — Autoriser ? », ou un nouveau domaine à approuver. L'app répond dans <id>.done.json.
struct AccessRequest: Identifiable, Equatable {
    var id: String
    var kind: String          // access | domain | generic
    var site: String
    var domain: String
    var caller: String
    var reason: String
    var channel: String
    var title: String
    var message: String
    var okLabel: String
    var cancelLabel: String
    var offerAlways: Bool
    var ts: Date

    var heading: String {
        switch kind {
        case "access": return t("ask_access_title", site)
        case "domain": return t("ask_domain_title", site)
        default: return title.isEmpty ? "Sésame" : title
        }
    }
}

/// La fenêtre de demande d'accès : flottante, sur tous les bureaux, jamais volée au clavier (voir Windows.showAsk).
/// Un seul geste attendu : « Autoriser » ou « Refuser ». Pour un site qu'on veut automatiser, la case
/// « Ne plus me demander pour ce site » passe sa règle à « Automatique ».
struct AccessRequestView: View {
    let request: AccessRequest
    let onAnswer: (_ allowed: Bool, _ always: Bool) -> Void
    @State private var always = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(nsImage: SeedIcon.appIcon(size: 64)).resizable().frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 3) {
                    Text(request.heading).font(.system(size: 14, weight: .semibold))
                    if request.kind == "access" {
                        Text(t("ask_access_line", request.caller, request.domain))
                            .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(request.message)
                            .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            if request.kind == "access" {
                VStack(alignment: .leading, spacing: 6) {
                    if !request.reason.isEmpty {
                        line(icon: "text.quote", text: t("ask_reason_line", request.reason))
                    }
                    if !request.channel.isEmpty {
                        line(icon: "macwindow", text: t("ask_channel_line", request.channel))
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
            }

            if request.offerAlways {
                Toggle(isOn: $always) { Text(t("ask_always", request.site)).font(.system(size: 11)) }
                    .toggleStyle(.checkbox)
            }

            HStack {
                Text(t("ask_footer")).font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button(request.cancelLabel.isEmpty ? t("ask_deny") : request.cancelLabel) { onAnswer(false, false) }
                    .keyboardShortcut(.cancelAction)
                Button(request.okLabel.isEmpty ? t("ask_allow") : request.okLabel) { onAnswer(true, always) }
                    .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
            }
        }
        .padding(18)
        .frame(width: 440)
    }

    private func line(icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).font(.system(size: 10)).foregroundStyle(.secondary).frame(width: 12)
            Text(text).font(.system(size: 11)).fixedSize(horizontal: false, vertical: true)
        }
    }
}
