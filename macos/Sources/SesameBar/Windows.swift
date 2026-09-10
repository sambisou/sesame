import SwiftUI
import AppKit

/// Une demande d'enregistrement déposée par le serveur MCP (~/.sesame/requests/<id>.json).
struct SiteRequest: Identifiable, Equatable {
    var id: String
    var site: String
    var url: String
    var reason: String
    var note: String?
    var caller: String
    var ts: Date
    /// Domaines supplémentaires proposés par Claude (fournisseur d'identité sur un autre domaine
    /// enregistrable) : pré-remplit le champ correspondant du formulaire, modifiable par l'utilisateur.
    var extraDomains: [String] = []
}

/// Fenêtres ordinaires (pas le menu) : le formulaire d'identifiants, pour une demande de Claude ou un ajout manuel.
/// `Windows` est lui-même le délégué de chaque fenêtre (un objet retenu, jamais désalloué) : la fermeture par le
/// bouton rouge vaut « Plus tard » et répond au serveur tout de suite.
@MainActor
final class Windows: NSObject, NSWindowDelegate {
    static let shared = Windows()
    private var open: [String: NSWindow] = [:]
    private var onClose: [String: () -> Void] = [:]

    func showRequest(_ r: SiteRequest, store: Store) {
        show(key: "req-" + r.id, title: "Sésame — \(r.site)", store: store, request: r) { saved in
            store.resolveRequest(r.id, saved: saved)
        }
    }

    /// Demande d'accès : fenêtre flottante (au-dessus de tout), présente sur tous les bureaux et au-dessus d'une
    /// app en plein écran, posée sous la barre des menus à droite, et — c'est le point — SANS activer Sésame :
    /// si l'utilisateur est en train de taper un code dans Chrome, le clavier lui reste. Il clique quand il veut.
    /// Plusieurs demandes à la fois : elles se décalent en cascade au lieu de se recouvrir.
    func showAsk(_ r: AccessRequest, store: Store) {
        let key = "ask-" + r.id
        if let w = open[key] { w.orderFrontRegardless(); return }
        let host = NSHostingController(rootView: AccessRequestView(request: r) { allowed, always in
            store.resolveAsk(r.id, allowed: allowed, always: always)
        })
        // Un NSPanel NON ACTIVANT : c'est ce qui permet à une app de la barre des menus (accessory, sans
        // icône du Dock) de MONTRER une fenêtre cliquable SANS s'activer ni voler le clavier. Une NSWindow
        // ordinaire d'une app accessory qui ne s'active jamais ne s'affiche pas — d'où cette panel.
        let w = NSPanel(contentViewController: host)
        w.title = r.kind == "domain" ? t("win_ask_domain_title") : t("win_ask_title")
        w.styleMask = [.titled, .closable, .nonactivatingPanel]
        w.isFloatingPanel = true
        w.becomesKeyOnlyIfNeeded = true
        w.hidesOnDeactivate = false
        w.isReleasedWhenClosed = false
        w.level = .floating
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        w.delegate = self
        open[key] = w
        // Bouton rouge : vaut « Refuser ».
        onClose[key] = { store.resolveAsk(r.id, allowed: false, always: false) }
        placeUnderMenuBar(w, index: open.keys.filter { $0.hasPrefix("ask-") }.count - 1)
        w.orderFrontRegardless()
    }

    /// Ferme la fenêtre d'une question (répondue, ou retirée par le serveur) sans rappeler le serveur.
    func closeAsk(_ id: String) { close("ask-" + id) }

    /// Ramène toutes les questions en attente au premier plan (depuis le panneau : « Afficher »).
    func frontAsks() {
        for (k, w) in open where k.hasPrefix("ask-") { w.orderFrontRegardless() }
    }

    /// Coin haut droit de l'écran où est la souris (celui que l'utilisateur regarde), sous la barre des menus,
    /// décalé en cascade pour la n-ième fenêtre.
    private func placeUnderMenuBar(_ w: NSWindow, index: Int) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
        let v = screen.visibleFrame
        let size = w.frame.size
        let step = CGFloat(min(index, 6)) * 28
        let x = v.maxX - size.width - 16 - step
        let y = v.maxY - size.height - 12 - step
        w.setFrameOrigin(NSPoint(x: max(v.minX + 8, x), y: max(v.minY + 8, y)))
    }

    func showAdd(store: Store) {
        show(key: "add", title: t("win_add_site_title"), store: store, request: nil) { _ in }
    }

    /// Installation guidée de l'extension Chrome.
    func showExtensionSetup(store: Store) {
        let key = "extension"
        if let w = open[key] { w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let w = NSWindow(contentViewController: NSHostingController(rootView: ExtensionSetupView(store: store)))
        w.title = t("win_extension_title")
        w.styleMask = [.titled, .closable]
        w.isReleasedWhenClosed = false
        w.center()
        w.delegate = self
        open[key] = w
        onClose[key] = {}
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Fenêtre d'accueil (trois écrans), première ouverture seulement (voir Store.checkFirstRun). « Terminer »
    /// marque le marqueur puis enchaîne directement sur l'ajout du premier site.
    func showOnboarding(store: Store) {
        let key = "onboarding"
        if let w = open[key] { w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let host = NSHostingController(rootView: OnboardingView(store: store) { [weak self] in
            store.markOnboarded()
            self?.close(key)
            Windows.shared.showAdd(store: store)
        })
        let w = NSWindow(contentViewController: host)
        w.title = t("win_onboarding_title")
        w.styleMask = [.titled, .closable]
        w.isReleasedWhenClosed = false
        w.level = .floating
        w.center()
        w.delegate = self
        open[key] = w
        // Fermeture par le bouton rouge avant « Terminer » : ne pas re-proposer l'accueil au prochain lancement.
        onClose[key] = { store.markOnboarded() }
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Réglages : démarrage à l'ouverture de session, réinstallation Claude, dossier de Sésame, version.
    func showSettings(store: Store) {
        let key = "settings"
        if let w = open[key] { w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let w = NSWindow(contentViewController: NSHostingController(rootView: SettingsView(store: store)))
        w.title = t("win_settings_title")
        w.styleMask = [.titled, .closable]
        w.isReleasedWhenClosed = false
        w.center()
        w.delegate = self
        open[key] = w
        onClose[key] = {}
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func show(key: String, title: String, store: Store, request: SiteRequest?, onDone: @escaping (Bool) -> Void) {
        if let w = open[key] { w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let host = NSHostingController(rootView: CredentialForm(store: store, request: request) { [weak self] saved in
            onDone(saved)
            self?.close(key)
        })
        let w = NSWindow(contentViewController: host)
        w.title = title
        w.styleMask = [.titled, .closable]
        w.isReleasedWhenClosed = false
        w.level = .floating
        w.center()
        w.delegate = self
        open[key] = w
        onClose[key] = { if request != nil { onDone(false) } }
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Fermeture programmée (après « Enregistrer » ou « Plus tard ») : le délégué est retiré avant, pour ne pas répondre deux fois.
    private func close(_ key: String) {
        guard let w = open.removeValue(forKey: key) else { return }
        onClose.removeValue(forKey: key)
        w.delegate = nil
        w.close()
    }

    /// Bouton rouge ou Cmd+W : vaut « Plus tard ».
    func windowWillClose(_ notification: Notification) {
        guard let w = notification.object as? NSWindow, let key = open.first(where: { $0.value === w })?.key else { return }
        open.removeValue(forKey: key)
        let cb = onClose.removeValue(forKey: key)
        w.delegate = nil
        cb?()
    }
}
