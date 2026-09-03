// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SesameBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "SesameBar",
            path: "Sources/SesameBar",
            exclude: ["Resources/Info.plist"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // Assistant Trousseau : petit exécutable signé, sans dépendance, que src/keychain.js appelle pour
        // lire le Trousseau sans jamais passer par /usr/bin/security (voir Sources/SesameKeychain/main.swift).
        .executableTarget(
            name: "SesameKeychain",
            path: "Sources/SesameKeychain",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
