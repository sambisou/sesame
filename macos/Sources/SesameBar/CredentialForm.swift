import SwiftUI
import AppKit

/// Le formulaire d'identifiants de Sésame : identifiant et mot de passe sur la même fenêtre,
/// œil pour afficher le mot de passe. Le mot de passe va au Trousseau, jamais ailleurs.
struct CredentialForm: View {
    let store: Store
    /// Demande venue de Claude (site et URL imposés) ; nil quand l'utilisateur ajoute un site lui-même.
    let request: SiteRequest?
    let onDone: (Bool) -> Void

    @State private var name: String
    @State private var url: String
    @State private var username = ""
    @State private var password = ""
    @State private var note: String
    @State private var extraDomainsText: String
    @State private var reveal = false
    @State private var error: String?
    @State private var busy = false

    init(store: Store, request: SiteRequest?, onDone: @escaping (Bool) -> Void) {
        self.store = store; self.request = request; self.onDone = onDone
        _name = State(initialValue: request?.site ?? "")
        _url = State(initialValue: request?.url ?? "")
        _note = State(initialValue: request?.note ?? "")
        _extraDomainsText = State(initialValue: (request?.extraDomains ?? []).joined(separator: ", "))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(nsImage: SeedIcon.appIcon(size: 64)).resizable().frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(request == nil ? t("cred_add_title") : t("cred_need_title", request!.site))
                        .font(.system(size: 14, weight: .semibold))
                    if let r = request {
                        Text(t("cred_caller_wants", r.caller, Store.siteDomain(for: URL(string: r.url)?.host ?? r.url)) + (r.reason.isEmpty ? "" : t("cred_reason_suffix", r.reason)))
                            .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(3)
                    } else {
                        Text(t("cred_subtitle_no_request"))
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
            }

            VStack(spacing: 8) {
                if request == nil {
                    row(t("label_name")) { TextField("", text: $name, prompt: Text("infomaniak")).textFieldStyle(.roundedBorder) }
                    row(t("label_login_page")) { TextField("", text: $url, prompt: Text(t("placeholder_login_url"))).textFieldStyle(.roundedBorder) }
                } else {
                    row(t("label_login_page")) { Text(url).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).frame(maxWidth: .infinity, alignment: .leading) }
                }
                row(t("label_username")) { TextField("", text: $username, prompt: Text(t("placeholder_username"))).textFieldStyle(.roundedBorder) }
                row(t("label_password")) {
                    HStack(spacing: 6) {
                        Group {
                            if reveal { TextField("", text: $password).textFieldStyle(.roundedBorder) }
                            else { SecureField("", text: $password).textFieldStyle(.roundedBorder) }
                        }
                        Button { reveal.toggle() } label: {
                            Image(systemName: reveal ? "eye.slash" : "eye").font(.system(size: 13))
                        }
                        .buttonStyle(.plain).foregroundStyle(.secondary).help(reveal ? t("eye_hide") : t("eye_show"))
                    }
                }
                row(t("label_note")) { TextField("", text: $note, prompt: Text(t("placeholder_note"))).textFieldStyle(.roundedBorder) }
                row(t("label_extra_domains")) { TextField("", text: $extraDomainsText, prompt: Text(t("placeholder_extra_domains"))).textFieldStyle(.roundedBorder) }
            }
            Text(t("extra_domains_help"))
                .font(.system(size: 10)).foregroundStyle(.secondary)

            if let e = error { Text(e).font(.system(size: 11)).foregroundStyle(Color(red: 0.7, green: 0.23, blue: 0.18)) }

            HStack {
                Text(t("keychain_footer"))
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                Spacer()
                Button(request == nil ? t("cancel") : t("later")) { onDone(false) }.keyboardShortcut(.cancelAction)
                Button(t("save")) { save() }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                    .disabled(busy || name.isEmpty || url.isEmpty || password.isEmpty)
            }
        }
        .padding(18)
        .frame(width: 460)
    }

    private func row<V: View>(_ label: String, @ViewBuilder _ content: () -> V) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 118, alignment: .trailing)
            content()
        }
    }

    private func save() {
        busy = true
        let extras = extraDomainsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if let e = store.addSite(name: name, url: url, username: username, password: password, note: note, extraDomains: extras) {
            error = e; busy = false
        } else {
            password = ""
            onDone(true)
        }
    }
}
