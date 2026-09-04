import AppKit

/// Fond de la fenêtre du .dmg : 640 × 400, sobre, avec la graine de Sésame et une flèche vers l'alias
/// Applications. Dessiné en Swift comme l'icône (SeedIcon, dans SesameApp.swift) — mêmes formes, pas
/// d'image externe. Les coordonnées des deux icônes (SESAME_ICON_CENTER / APPLICATIONS_ICON_CENTER)
/// sont réutilisées telles quelles par scripts/make-dmg.sh pour positionner les icônes réelles dans la
/// fenêtre Finder : la flèche doit pointer exactement entre les deux.
enum DMGBackground {
    static let size = NSSize(width: 640, height: 400)
    /// Centres d'icône (repère Quartz : origine en bas à gauche), repris par make-dmg.sh (repère Finder :
    /// origine en haut à gauche) via `y_finder = height - y_quartz`.
    static let sesameIconCenter = NSPoint(x: 170, y: 230)
    static let applicationsIconCenter = NSPoint(x: 470, y: 230)

    static func draw() -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return true }

            // Fond sobre : un gris chaud très clair, cohérent avec l'icône (dégradé sombre + graine dorée)
            // sans lui faire concurrence — la fenêtre Finder doit rester lisible.
            let top = NSColor(red: 0.97, green: 0.965, blue: 0.955, alpha: 1)
            let bottom = NSColor(red: 0.93, green: 0.925, blue: 0.915, alpha: 1)
            let bg = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [top.cgColor, bottom.cgColor] as CFArray, locations: [0, 1])!
            ctx.drawLinearGradient(bg, start: CGPoint(x: 0, y: rect.height), end: CGPoint(x: 0, y: 0), options: [])

            // Fine bordure pour détacher la fenêtre du bureau, sans cadre trop appuyé.
            NSColor(white: 0, alpha: 0.06).setStroke()
            let border = NSBezierPath(rect: rect.insetBy(dx: 0.5, dy: 0.5))
            border.lineWidth = 1
            border.stroke()

            // Flèche entre les deux futures icônes (app à gauche, alias Applications à droite) : mêmes
            // centres que sesameIconCenter / applicationsIconCenter, une icône Finder faisant ~80pt de large
            // en taille d'affichage courante, donc une flèche qui s'arrête à bonne distance de chaque icône.
            let y = sesameIconCenter.y
            let startX = sesameIconCenter.x + 58
            let endX = applicationsIconCenter.x - 58
            let shaftHeight: CGFloat = 7
            let headWidth: CGFloat = 26
            let headHeight: CGFloat = 22
            let arrow = NSBezierPath()
            arrow.move(to: NSPoint(x: startX, y: y - shaftHeight / 2))
            arrow.line(to: NSPoint(x: endX - headWidth, y: y - shaftHeight / 2))
            arrow.line(to: NSPoint(x: endX - headWidth, y: y - headHeight / 2))
            arrow.line(to: NSPoint(x: endX, y: y))
            arrow.line(to: NSPoint(x: endX - headWidth, y: y + headHeight / 2))
            arrow.line(to: NSPoint(x: endX - headWidth, y: y + shaftHeight / 2))
            arrow.line(to: NSPoint(x: startX, y: y + shaftHeight / 2))
            arrow.close()
            NSColor(red: 0.72, green: 0.55, blue: 0.22, alpha: 0.9).setFill()   // même famille dorée que la graine
            arrow.fill()

            // La graine en filigrane, en haut au centre : une signature de marque qui ne gêne ni les deux
            // icônes (Finder les dessine par-dessus, aux mêmes centres que sesameIconCenter /
            // applicationsIconCenter) ni la flèche, sans les dupliquer.
            ctx.saveGState()
            let glyphSize: CGFloat = 40
            ctx.translateBy(x: size.width / 2 - glyphSize / 2, y: size.height - 74)
            ctx.scaleBy(x: glyphSize / 100, y: glyphSize / 100)
            NSColor(red: 0.55, green: 0.42, blue: 0.18, alpha: 0.5).setFill()
            SeedIcon.drawGlyph(in: ctx, keyhole: false)
            ctx.restoreGState()

            return true
        }
        image.isTemplate = false
        return image
    }

    /// Écrit le PNG 640×400 à `path`. Utilisé par `SesameBar --export-dmg-background <path>` (voir
    /// SesameApp.swift), lui-même appelé par scripts/make-dmg.sh.
    static func export(to path: String) {
        let img = draw()
        guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: URL(fileURLWithPath: path))
    }
}
