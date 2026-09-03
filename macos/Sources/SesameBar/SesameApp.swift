import SwiftUI
import AppKit

@main
struct SesameApp: App {
    @State private var store = Store()

    init() {
        // `SesameBar --export-iconset <dossier>` : produit les PNG de l'icône puis quitte (utilisé par make-app.sh).
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--export-iconset"), i + 1 < args.count {
            SeedIcon.exportIconset(to: args[i + 1])
            exit(0)
        }
    }

    var body: some Scene {
        MenuBarExtra {
            Panel(store: store)
        } label: {
            Image(nsImage: SeedIcon.menuBar(alert: store.locked))
                .onAppear { store.start() }
        }
        .menuBarExtraStyle(.window)
    }
}

/// La graine de sésame avec son trou de serrure. En barre des menus : image template (blanche sur barre sombre).
enum SeedIcon {
    /// Dessine la graine dans un carré de 100 × 100 (origine en bas à gauche).
    static func drawGlyph(in ctx: CGContext, keyhole: Bool = true) {
        let seed = NSBezierPath()
        seed.move(to: NSPoint(x: 50, y: 96))
        seed.curve(to: NSPoint(x: 84, y: 36), controlPoint1: NSPoint(x: 72, y: 78), controlPoint2: NSPoint(x: 84, y: 58))
        seed.curve(to: NSPoint(x: 50, y: 4), controlPoint1: NSPoint(x: 84, y: 16), controlPoint2: NSPoint(x: 69, y: 4))
        seed.curve(to: NSPoint(x: 16, y: 36), controlPoint1: NSPoint(x: 31, y: 4), controlPoint2: NSPoint(x: 16, y: 16))
        seed.curve(to: NSPoint(x: 50, y: 96), controlPoint1: NSPoint(x: 16, y: 58), controlPoint2: NSPoint(x: 28, y: 78))
        seed.close()
        if keyhole {
            let hole = NSBezierPath(ovalIn: NSRect(x: 39, y: 40, width: 22, height: 22))
            hole.move(to: NSPoint(x: 46, y: 42)); hole.line(to: NSPoint(x: 54, y: 42))
            hole.line(to: NSPoint(x: 58, y: 22)); hole.line(to: NSPoint(x: 42, y: 22)); hole.close()
            seed.append(hole)
            seed.windingRule = .evenOdd
        }
        seed.fill()
    }

    static func menuBar(alert: Bool, size: CGFloat = 18) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return true }
            ctx.saveGState()
            ctx.scaleBy(x: rect.width / 100, y: rect.height / 100)
            NSColor.black.setFill()
            drawGlyph(in: ctx)
            ctx.restoreGState()
            if alert {
                // Verrou actif : une barre détourée en travers de la graine.
                ctx.setBlendMode(.clear)
                NSBezierPath(rect: NSRect(x: 1, y: rect.height / 2 - 2.2, width: rect.width - 2, height: 4.4)).fill()
                ctx.setBlendMode(.normal)
                NSColor.black.setFill()
                NSBezierPath(rect: NSRect(x: 2, y: rect.height / 2 - 1, width: rect.width - 4, height: 2)).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
    }

    /// Icône d'application : graine dorée sur fond sombre, coins arrondis.
    static func appIcon(size: CGFloat) -> NSImage {
        NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return true }
            let inset = size * 0.085
            let box = rect.insetBy(dx: inset, dy: inset)
            ctx.saveGState()
            ctx.addPath(CGPath(roundedRect: box, cornerWidth: size * 0.225, cornerHeight: size * 0.225, transform: nil)); ctx.clip()
            let colors = [NSColor(red: 0.16, green: 0.14, blue: 0.12, alpha: 1).cgColor, NSColor(red: 0.08, green: 0.07, blue: 0.06, alpha: 1).cgColor] as CFArray
            let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
            ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: size), end: CGPoint(x: size, y: 0), options: [])
            ctx.restoreGState()
            ctx.saveGState()
            let side = size * 0.56
            ctx.translateBy(x: (size - side) / 2, y: (size - side) / 2)
            ctx.scaleBy(x: side / 100, y: side / 100)
            NSColor(red: 0.85, green: 0.64, blue: 0.25, alpha: 1).setFill()
            drawGlyph(in: ctx)
            ctx.restoreGState()
            return true
        }
    }

    static func exportIconset(to dir: String) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        for (name, px) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
            let img = appIcon(size: CGFloat(px))
            guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { continue }
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
        }
    }
}
