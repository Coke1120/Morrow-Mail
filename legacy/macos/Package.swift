// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "MorrowMail",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "MorrowMail", targets: ["MorrowMail"])],
    targets: [
        .executableTarget(name: "MorrowMail")
    ]
)
