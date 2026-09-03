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

    func showAdd(store: Store) {
        show(key: "add", title: "Sésame — ajouter un site", store: store, request: nil) { _ in }
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
