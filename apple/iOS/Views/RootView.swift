import PracticeCore
import SwiftUI

enum AppTab: String, Hashable {
    case summary, library, split, tools
}

/// Navigation state shared by all tabs (so a Summary card can open a piece in the Library tab).
@MainActor
final class Router: ObservableObject {
    @Published var tab: AppTab = .summary
    @Published var libraryPath: [LibraryItem] = []
    @Published var splitPath: [LibraryItem] = []
    @Published var showAccount = false
    @Published var paywall: PlusFeature?
    /// A recording picked elsewhere (Library import, a shared file, a song link) waiting for Band Split.
    @Published var pendingSplitFile: URL?
    @Published var pendingSplitLink: SongLink?

    func open(_ item: LibraryItem) {
        if item.isSplit {
            tab = .split
            splitPath = [item]
        } else {
            tab = .library
            libraryPath = [item]
        }
    }

    /// Runs `action` if the user has Plus or still has free uses of `feature`; otherwise shows the paywall.
    func gate(_ feature: PlusFeature, store: Store, action: () -> Void) {
        if store.isPlus || feature.remaining > 0 {
            if !store.isPlus { feature.consume() }
            action()
        } else {
            paywall = feature
        }
    }
}

/// Tab bar on iPhone; sidebar on iPad and Mac (like the Health and Music apps).
struct RootView: View {
    @EnvironmentObject var router: Router
    @EnvironmentObject var store: Store

    var body: some View {
        TabView(selection: $router.tab) {
            Tab("Summary", systemImage: "heart.text.square.fill", value: AppTab.summary) {
                SummaryView()
            }
            Tab("Library", systemImage: "music.note.list", value: AppTab.library) {
                LibraryView()
            }
            Tab("Band Split", systemImage: "slider.vertical.3", value: AppTab.split) {
                SplitHomeView()
            }
            Tab("Tools", systemImage: "tuningfork", value: AppTab.tools) {
                ToolsView()
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .sheet(isPresented: $router.showAccount) {
            AccountView()
        }
        .sheet(item: $router.paywall) { feature in
            PaywallView(highlight: feature)
        }
    }
}
