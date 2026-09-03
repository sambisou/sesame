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
        )
    ]
)
