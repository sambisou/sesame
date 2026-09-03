import SwiftUI
import AppKit

enum Palette {
    static let seed = Color(red: 0.77, green: 0.54, blue: 0.13)
    static let ok = Color(red: 0.18, green: 0.48, blue: 0.31)
    static let no = Color(red: 0.70, green: 0.23, blue: 0.18)
    static let wait = Color(red: 0.85, green: 0.58, blue: 0.15)
    static let line = Color.primary.opacity(0.08)
    static let muted = Color.secondary
}

struct Panel: View {
    @Bindable var store: Store
    @State private var confirmRemove: Site?

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Palette.seed).frame(height: 3)
            header
            Divider().overlay(Palette.line)
            ScrollView {
                VStack(spacing: 0) {
                    sectionTitle("Sites", trailing: "\(store.sites.count)")
                    if store.sites.isEmpty { emptyLine("Aucun site. Ajoute-en un ci-dessous : Claude pourra s'y connecter sans jamais voir le mot de passe.") }
                    ForEach(store.sites) { s in siteRow(s) }
                    addBlock
                    sectionTitle("Navigateur", trailing: "")
                    extensionRow
                    sectionTitle("Journal", trailing: "\(min(visibleEvents.count, 8)) dernières")
                    if visibleEvents.isEmpty { emptyLine("Rien encore.") }
                    ForEach(visibleEvents.prefix(8)) { e in eventRow(e) }
                }
                .padding(.bottom, 6)
            }
            .frame(height: listHeight)
            Divider().overlay(Palette.line)
            footer
        }
        .frame(width: 372)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    /// Le journal du panneau ne montre que ce qui concerne l'utilisateur : pas les démarrages techniques du serveur.
    private var visibleEvents: [Event] {
        store.events.filter { !["server_start", "http_start", "chrome_start"].contains($0.action) }
    }

    private var listHeight: CGFloat {
        let rows = CGFloat(store.sites.count) * 58 + (confirmRemove == nil ? 0 : 34) + CGFloat(min(visibleEvents.count, 8)) * 24 + 40 + 70 + (store.extensionStatus.level == 3 ? 56 : 84)
        return min(max(rows, 180), 560)
    }

    // MARK: en-tête

    private var header: some View {
        HStack(spacing: 10) {
            Image(nsImage: SeedIcon.appIcon(size: 44)).resizable().frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text("Sésame").font(.system(size: 14, weight: .semibold))
                Text(store.locked ? "Verrou actif : aucune connexion possible" : "Claude se connecte, vous validez, le mot de passe reste ici")
                    .font(.system(size: 10.5)).foregroundStyle(store.locked ? Palette.no : Palette.muted)
            }
            Spacer()
            Toggle(isOn: Binding(get: { store.locked }, set: { _ in store.toggleLock() })) { Text("Verrou").font(.system(size: 11)) }
                .toggleStyle(.switch).controlSize(.mini).tint(Palette.no)
                .help("Coupe-circuit : bloque toutes les connexions, quel que soit le site.")
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    // MARK: sites

    private func siteRow(_ s: Site) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Circle().fill(policyColor(s.policy)).frame(width: 7, height: 7)
                Text(s.id).font(.system(size: 12.5, weight: .semibold))
                Text(s.domain).font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(1)
                Spacer()
                Text(relative(s.lastUsed)).font(.system(size: 10.5)).foregroundStyle(Palette.muted)
                Button { withAnimation(.easeOut(duration: 0.12)) { confirmRemove = (confirmRemove?.id == s.id) ? nil : s } } label: { Image(systemName: "trash").font(.system(size: 11)) }
                    .buttonStyle(.plain).foregroundStyle(confirmRemove?.id == s.id ? Palette.no : Palette.muted).help("Supprimer le site et son mot de passe")
            }
            if confirmRemove?.id == s.id {
                // Confirmation dans le panneau : une alerte système fermerait le menu et ne rendrait jamais la main.
                HStack(spacing: 8) {
                    Text("Retirer « \(s.id) » et son mot de passe du Trousseau ?").font(.system(size: 11)).foregroundStyle(Palette.no)
                    Spacer()
                    Button("Annuler") { confirmRemove = nil }.controlSize(.mini)
                    Button("Supprimer") { store.removeSite(s.id); confirmRemove = nil }.controlSize(.mini).tint(Palette.no).buttonStyle(.borderedProminent)
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Palette.no.opacity(0.08)))
            }
            HStack(spacing: 8) {
                Picker("", selection: Binding(get: { s.policy }, set: { store.setPolicy(s.id, $0) })) {
                    Text("Me demander").tag("ask")
                    Text("Automatique").tag("always")
                    Text("Coupé").tag("revoked")
                }
                .pickerStyle(.segmented).controlSize(.small).labelsHidden().frame(width: 250)
                Spacer()
                if let n = s.note, !n.isEmpty {
                    Image(systemName: "info.circle").font(.system(size: 11)).foregroundStyle(Palette.muted).help(n)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 7)
        .background(Color.primary.opacity(0.001))
    }

    private func policyColor(_ p: String) -> Color {
        switch p { case "always": return Palette.ok; case "revoked": return Palette.no; default: return Palette.wait }
    }

    // MARK: ajout

    private var addBlock: some View {
        Button {
            Windows.shared.showAdd(store: store)
        } label: {
            Label("Ajouter un site…", systemImage: "plus.circle").font(.system(size: 12, weight: .medium))
        }
        .buttonStyle(.plain).foregroundStyle(Palette.seed)
        .padding(.horizontal, 14).padding(.vertical, 8)
    }

    // MARK: extension Chrome

    /// État de l'extension et, si elle manque, l'invitation à l'installer (fenêtre guidée).
    private var extensionRow: some View {
        let st = store.extensionStatus
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(st.level == 3 ? Palette.ok : st.level > 0 ? Palette.wait : Palette.muted.opacity(0.4)).frame(width: 7, height: 7)
                Text(st.label).font(.system(size: 11.5, weight: .medium)).lineLimit(1)
                Spacer()
                Button(st.level == 3 ? "Réglages…" : "Installer…") { Windows.shared.showExtensionSetup(store: store) }.controlSize(.mini)
            }
            if st.level < 3 {
                Text(st.level == 0
                     ? "Sans extension, Sésame utilise un Chrome à part, lancé réduit, qui ne s'ouvre que pour un code."
                     : st.level == 1 ? "Chargez le dossier « extension » dans chrome://extensions, puis rechargez-la."
                     : "Ouvrez Chrome (ou rechargez l'extension) pour qu'elle se connecte au pont.")
                    .font(.system(size: 10.5)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
    }

    // MARK: journal

    private func eventRow(_ e: Event) -> some View {
        HStack(spacing: 8) {
            Text(time(e.ts)).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(Palette.muted).frame(width: 40, alignment: .leading)
            Circle().fill(resultColor(e.result)).frame(width: 6, height: 6)
            Text(e.site ?? "—").font(.system(size: 11, weight: .medium)).frame(width: 78, alignment: .leading).lineLimit(1)
            Text(actionLabel(e)).font(.system(size: 11)).lineLimit(1)
            Spacer()
            Text(e.caller ?? "").font(.system(size: 10)).foregroundStyle(Palette.muted)
        }
        .padding(.horizontal, 14).padding(.vertical, 3)
        .help(e.detail ?? "")
    }

    private func actionLabel(_ e: Event) -> String {
        let r = e.result ?? ""
        switch e.action {
        case "login": return r == "autorisé" ? "demande autorisée" : r == "refusé" ? "demande refusée" : r == "réussi" ? "connexion réussie" : r == "incertain" ? "connexion à vérifier" : "connexion : \(r)"
        case "2fa": return r == "attente" ? "code demandé, attente" : r == "réussi" ? "code accepté" : "code : \(r)"
        case "request_site": return r == "ok" ? "site enregistré" : "enregistrement \(r)"
        case "add_site", "update_site": return "site enregistré"
        case "remove_site": return "site supprimé"
        case "policy": return "règle : \(e.detail ?? "")"
        case "lock": return "verrou activé"
        case "unlock": return "verrou levé"
        case "chrome_start": return "Chrome Sésame lancé"
        case "open_login": return "page ouverte"
        case "server_start": return "serveur démarré"
        case "http_start": return "HTTP démarré"
        case "http_refuse": return "HTTP refusé (jeton)"
        default: return "\(e.action) \(r)"
        }
    }

    private func resultColor(_ r: String?) -> Color {
        switch r ?? "" {
        case "réussi", "ok", "autorisé": return Palette.ok
        case "refusé", "échec", "erreur": return Palette.no
        case "attente", "en attente", "incertain": return Palette.wait
        default: return Palette.muted.opacity(0.5)
        }
    }

    // MARK: pied

    private var footer: some View {
        HStack(spacing: 10) {
            Circle().fill(store.chromeUp ? Palette.ok : Palette.muted.opacity(0.4)).frame(width: 7, height: 7)
            Text(store.chromeUp ? "Chrome Sésame prêt" : "Chrome Sésame fermé").font(.system(size: 11)).foregroundStyle(Palette.muted)
            if !store.chromeUp { Button("Ouvrir") { store.openChrome() }.controlSize(.mini) }
            Spacer()
            if let e = store.lastError { Text(e).font(.system(size: 10)).foregroundStyle(Palette.no).lineLimit(1).help(e) }
            Button("Quitter") { NSApplication.shared.terminate(nil) }.controlSize(.mini).buttonStyle(.plain).foregroundStyle(Palette.muted)
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
    }

    // MARK: petits utilitaires

    private func sectionTitle(_ t: String, trailing: String) -> some View {
        HStack {
            Text(t.uppercased()).font(.system(size: 10, weight: .semibold)).tracking(0.8).foregroundStyle(Palette.muted)
            Spacer()
            Text(trailing).font(.system(size: 10)).foregroundStyle(Palette.muted)
        }
        .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 4)
    }
    private func emptyLine(_ t: String) -> some View {
        Text(t).font(.system(size: 11)).foregroundStyle(Palette.muted).padding(.horizontal, 14).padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading)
    }
    private func time(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm" : "d MMM"; f.locale = Locale(identifier: "fr_FR")
        return f.string(from: d)
    }
    private func relative(_ d: Date?) -> String {
        guard let d else { return "jamais" }
        let f = RelativeDateTimeFormatter(); f.locale = Locale(identifier: "fr_FR"); f.unitsStyle = .short
        return f.localizedString(for: d, relativeTo: Date())
    }
}
