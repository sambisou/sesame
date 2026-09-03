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
    @State private var reveal = false
    @State private var error: String?
    @State private var busy = false

    init(store: Store, request: SiteRequest?, onDone: @escaping (Bool) -> Void) {
        self.store = store; self.request = request; self.onDone = onDone
        _name = State(initialValue: request?.site ?? "")
        _url = State(initialValue: request?.url ?? "")
        _note = State(initialValue: request?.note ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(nsImage: SeedIcon.appIcon(size: 64)).resizable().frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(request == nil ? "Ajouter un site" : "Claude a besoin de « \(request!.site) »")
                        .font(.system(size: 14, weight: .semibold))
                    if let r = request {
                        Text("\(r.caller) demande à se connecter à \(Store.siteDomain(for: URL(string: r.url)?.host ?? r.url))" + (r.reason.isEmpty ? "" : " — \(r.reason)"))
                            .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(3)
                    } else {
                        Text("Vos identifiants vont dans le Trousseau macOS. Claude ne les verra jamais.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
            }

            VStack(spacing: 8) {
                if request == nil {
                    row("Nom court") { TextField("", text: $name, prompt: Text("infomaniak")).textFieldStyle(.roundedBorder) }
                    row("Page de connexion") { TextField("", text: $url, prompt: Text("https://login.exemple.com/")).textFieldStyle(.roundedBorder) }
                } else {
                    row("Page de connexion") { Text(url).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).frame(maxWidth: .infinity, alignment: .leading) }
                }
                row("Identifiant") { TextField("", text: $username, prompt: Text("e-mail ou nom d'utilisateur")).textFieldStyle(.roundedBorder) }
                row("Mot de passe") {
                    HStack(spacing: 6) {
                        Group {
                            if reveal { TextField("", text: $password).textFieldStyle(.roundedBorder) }
                            else { SecureField("", text: $password).textFieldStyle(.roundedBorder) }
                        }
                        Button { reveal.toggle() } label: {
                            Image(systemName: reveal ? "eye.slash" : "eye").font(.system(size: 13))
                        }
                        .buttonStyle(.plain).foregroundStyle(.secondary).help(reveal ? "Masquer le mot de passe" : "Afficher le mot de passe")
                    }
                }
                row("Mémo (optionnel)") { TextField("", text: $note, prompt: Text("connexion en 2 étapes")).textFieldStyle(.roundedBorder) }
            }

            if let e = error { Text(e).font(.system(size: 11)).foregroundStyle(Color(red: 0.7, green: 0.23, blue: 0.18)) }

            HStack {
                Text("Enregistré dans le Trousseau, sans application de confiance : chaque lecture vous sera demandée.")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                Spacer()
                Button(request == nil ? "Annuler" : "Plus tard") { onDone(false) }.keyboardShortcut(.cancelAction)
                Button("Enregistrer") { save() }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
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
        if let e = store.addSite(name: name, url: url, username: username, password: password, note: note) {
            error = e; busy = false
        } else {
            password = ""
            onDone(true)
        }
    }
}
