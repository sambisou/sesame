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
                    if store.sites.isEmpty { emptyLine(t("panel_no_sites")) }
                    ForEach(store.sites) { s in siteRow(s) }
                    if !store.sitesToMigrate.isEmpty { migrationRow }
                    addBlock
                    sectionTitle(t("panel_browser"), trailing: "")
                    extensionRow
                    sectionTitle(t("panel_log"), trailing: t("panel_log_trailing", "\(min(visibleEvents.count, 8))"))
                    if visibleEvents.isEmpty { emptyLine(t("panel_log_empty")) }
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
            + (store.sitesToMigrate.isEmpty ? 0 : (store.migrationReport == nil ? 34 : 52))
        return min(max(rows, 180), 620)
    }

    // MARK: en-tête

    private var header: some View {
        HStack(spacing: 10) {
            Image(nsImage: SeedIcon.appIcon(size: 44)).resizable().frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text("Sésame").font(.system(size: 14, weight: .semibold))
                Text(store.locked ? t("panel_subtitle_locked") : t("panel_subtitle_unlocked"))
                    .font(.system(size: 10.5)).foregroundStyle(store.locked ? Palette.no : Palette.muted)
            }
            Spacer()
            Toggle(isOn: Binding(get: { store.locked }, set: { _ in store.toggleLock() })) { Text(t("panel_lock_toggle")).font(.system(size: 11)) }
                .toggleStyle(.switch).controlSize(.mini).tint(Palette.no)
                .help(t("panel_lock_help"))
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
                    .buttonStyle(.plain).foregroundStyle(confirmRemove?.id == s.id ? Palette.no : Palette.muted).help(t("site_remove_help"))
            }
            if confirmRemove?.id == s.id {
                // Confirmation dans le panneau : une alerte système fermerait le menu et ne rendrait jamais la main.
                HStack(spacing: 8) {
                    Text(t("site_remove_confirm", s.id)).font(.system(size: 11)).foregroundStyle(Palette.no)
                    Spacer()
                    Button(t("cancel")) { confirmRemove = nil }.controlSize(.mini)
                    Button(t("delete")) { store.removeSite(s.id); confirmRemove = nil }.controlSize(.mini).tint(Palette.no).buttonStyle(.borderedProminent)
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Palette.no.opacity(0.08)))
            }
            HStack(spacing: 8) {
                Picker("", selection: Binding(get: { s.policy }, set: { store.setPolicy(s.id, $0) })) {
                    Text(t("policy_auto")).tag("always")
                    Text(t("policy_ask")).tag("ask")
                    Text(t("policy_off")).tag("revoked")
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
            Label(t("add_site"), systemImage: "plus.circle").font(.system(size: 12, weight: .medium))
        }
        .buttonStyle(.plain).foregroundStyle(Palette.seed)
        .padding(.horizontal, 14).padding(.vertical, 8)
    }

    // MARK: migration Trousseau

    /// Sites créés avant 0.5.1 (ou par une autre application) : leur élément Trousseau redemandera à chaque
    /// lecture tant qu'il n'a pas été réécrit par l'assistant. « Migrer… » le fait pour tous d'un coup, ici
    /// même dans l'app : une fenêtre du Trousseau par site (« Autoriser »), puis c'est silencieux.
    private var migrationRow: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10)).foregroundStyle(Palette.wait)
                Text(t("migration_row", "\(store.sitesToMigrate.count)", store.sitesToMigrate.count > 1 ? "s" : ""))
                    .font(.system(size: 11)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                Spacer()
                if store.migrating {
                    ProgressView().controlSize(.mini)
                } else {
                    Button(t("migrate_button")) { migrate() }.controlSize(.mini)
                }
            }
            if let r = store.migrationReport {
                Text(r).font(.system(size: 10.5)).foregroundStyle(Palette.muted)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
    }

    /// Lance la migration de tous les sites signalés, séquentiellement, dans l'app : une fenêtre du
    /// Trousseau par site (l'utilisateur clique « Autoriser »), puis réécriture silencieuse par l'assistant.
    private func migrate() {
        store.migrationReport = nil
        store.migrating = true
        let keys = store.sitesToMigrate
        store.migrateKeychain(keys) { ok, total in
            store.migrating = false
            store.migrationReport = total == 0 ? nil : t("migration_report", "\(ok)", "\(total)")
        }
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
                Button(st.level == 3 ? t("ext_settings") : t("ext_install")) { Windows.shared.showExtensionSetup(store: store) }.controlSize(.mini)
            }
            if st.level < 3 {
                Text(st.level == 0
                     ? t("ext_desc_no_ext")
                     : st.level == 1 ? t("ext_desc_declared")
                     : t("ext_desc_bridge"))
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
        case "login": return r == "autorisé" ? t("login_authorized") : r == "refusé" ? t("login_denied") : r == "réussi" ? t("login_success") : r == "incertain" ? t("login_uncertain") : t("login_other", r)
        case "2fa": return r == "attente" ? t("twofa_waiting") : r == "réussi" ? t("twofa_accepted") : t("twofa_other", r)
        case "request_site": return r == "ok" ? t("site_registered") : t("request_other", r)
        case "add_site", "update_site": return t("site_registered")
        case "remove_site": return t("site_removed")
        case "policy": return t("policy_changed", e.detail ?? "")
        case "lock": return t("all_locked")
        case "unlock": return t("unlocked")
        case "chrome_start": return t("chrome_started")
        case "open_login": return t("page_opened")
        case "server_start": return t("server_started")
        case "http_start": return t("http_started")
        case "http_refuse": return t("http_refused")
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
            Text(store.chromeUp ? t("footer_chrome_ready") : t("footer_chrome_closed")).font(.system(size: 11)).foregroundStyle(Palette.muted)
            if !store.chromeUp { Button(t("open")) { store.openChrome() }.controlSize(.mini) }
            Spacer()
            if let e = store.lastError { Text(e).font(.system(size: 10)).foregroundStyle(Palette.no).lineLimit(1).help(e) }
            Button(t("quit")) { NSApplication.shared.terminate(nil) }.controlSize(.mini).buttonStyle(.plain).foregroundStyle(Palette.muted)
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
        let f = DateFormatter(); f.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm" : "d MMM"; f.locale = Locale.current
        return f.string(from: d)
    }
    private func relative(_ d: Date?) -> String {
        guard let d else { return t("never") }
        let f = RelativeDateTimeFormatter(); f.locale = Locale.current; f.unitsStyle = .short
        return f.localizedString(for: d, relativeTo: Date())
    }
}
