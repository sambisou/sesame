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
@MainActor
final class Windows {
    static let shared = Windows()
    private var open: [String: NSWindow] = [:]

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
        w.delegate = Closer(key: key) { [weak self] k in
            if request != nil { onDone(false) }
            self?.open.removeValue(forKey: k)
        }
        open[key] = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func close(_ key: String) {
        guard let w = open.removeValue(forKey: key) else { return }
        w.delegate = nil
        w.close()
    }

    /// Fermeture par le bouton rouge : vaut « Plus tard ».
    private final class Closer: NSObject, NSWindowDelegate {
        let key: String; let onClose: (String) -> Void
        init(key: String, onClose: @escaping (String) -> Void) { self.key = key; self.onClose = onClose }
        func windowWillClose(_ notification: Notification) { onClose(key) }
    }
}
