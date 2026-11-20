import PracticeCore
import SwiftUI

@main
struct HaptuneApp: App {
    @StateObject private var library = Library()
    @StateObject private var settings = AppSettings()
    @StateObject private var store = Store()
    @StateObject private var router = Router()
    @StateObject private var splits = SplitCenter()
    @Environment(\.scenePhase) private var scenePhase

    init() { WatchLink.shared.activate() }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(library)
                .environmentObject(settings)
                .environmentObject(store)
                .environmentObject(router)
                .environmentObject(splits)
                .environment(\.locale, settings.language.locale)
                .task {
                    await library.useCloud(settings.iCloudSync)
                    DemoData.seedIfNeeded(library: library, splits: splits, settings: settings)
                    openDemoScreen()
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { library.reload() }
                }
                .onOpenURL { url in open(url) }
        }
        #if targetEnvironment(macCatalyst)
        .defaultSize(width: 1180, height: 820)
        #endif
    }

    /// "Open in Haptune" from Files, Mail, Safari, WhatsApp, Voice Memos...
    private func open(_ url: URL) {
        switch Importer.kind(of: url) {
        case .recording:
            router.pendingSplitFile = (try? Importer.temporaryCopy(of: url)) ?? url
            router.tab = .split
        default:
            Task {
                do {
                    let r = try await Importer(api: settings.api).importFile(url, instrument: settings.instrument)
                    let inst = r.score.parts.first.map { $0.instrument.isEmpty ? settings.instrumentKey : $0.instrument } ?? settings.instrumentKey
                    let item = try library.add(score: r.score, musicXML: r.musicXML, instrument: inst, kind: r.kind)
                    router.open(item)
                } catch {
                    router.tab = .library
                }
            }
        }
    }

    /// Screenshots: `-HaptuneDemo YES -HaptuneScreen <summary|library|practice|split|mixer|tools|account|paywall>`.
    private func openDemoScreen() {
        guard AppSettings.isDemo else { return }
        switch AppSettings.demoScreen {
        case "library": router.tab = .library
        case "practice":
            if let item = library.items.first(where: { $0.sourceKind == "musicxml" }) { router.open(item) }
        case "split": router.tab = .split
        case "mixer":
            if let item = library.items.first(where: { $0.isSplit }) { router.open(item) }
        case "tools": router.tab = .tools
        case "account": router.showAccount = true
        case "paywall": router.paywall = .bandSplit
        default: router.tab = .summary
        }
    }
}
