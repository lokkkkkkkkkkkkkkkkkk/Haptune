// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PracticeCore",
    platforms: [.iOS(.v17), .watchOS(.v10), .macOS(.v14)],
    products: [
        .library(name: "PracticeCore", targets: ["PracticeCore"]),
    ],
    dependencies: [
        // .mxl files are zip archives
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", from: "0.9.19"),
    ],
    targets: [
        .target(
            name: "PracticeCore",
            dependencies: [.product(name: "ZIPFoundation", package: "ZIPFoundation")],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "PracticeCoreTests", dependencies: ["PracticeCore"], resources: [.copy("Fixtures")]),
    ]
)
