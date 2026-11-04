import Foundation
import StoreKit
import SwiftUI

/// Haptune Plus: subscription (monthly / yearly with a free week) or a one-time lifetime unlock.
/// Prices and the payment sheet come from the App Store (StoreKit 2). `Haptune.storekit` lets you
/// test purchases in Xcode and the simulator without App Store Connect.
@MainActor
final class Store: ObservableObject {
    static let yearly = "com.haptune.app.plus.yearly"
    static let monthly = "com.haptune.app.plus.monthly"
    static let lifetime = "com.haptune.app.plus.lifetime"
    static let productIDs = [yearly, monthly, lifetime]
    static let tester = "tester"

    /// Test builds (the .ipa you sideload with a free Apple ID) can't buy anything from the App Store,
    /// so every Plus feature is unlocked. CI builds them with `SWIFT_ACTIVE_COMPILATION_CONDITIONS=TESTER`.
    static var isTestBuild: Bool {
        #if TESTER
        return true
        #else
        return false
        #endif
    }

    @Published private(set) var products: [Product] = []
    @Published private(set) var isPlus = false
    @Published private(set) var activeProductID: String?
    @Published private(set) var renewalDate: Date?
    @Published private(set) var loaded = false
    @Published var message: String?

    private var updates: Task<Void, Never>?

    init() {
        updates = Task { [weak self] in
            for await result in Transaction.updates {
                if case .verified(let t) = result { await t.finish() }
                await self?.refreshEntitlements()
            }
        }
        Task { await load() }
    }

    deinit { updates?.cancel() }

    func load() async {
        do {
            let found = try await Product.products(for: Self.productIDs)
            products = found.sorted { (Self.productIDs.firstIndex(of: $0.id) ?? 9) < (Self.productIDs.firstIndex(of: $1.id) ?? 9) }
        } catch {
            products = []
        }
        loaded = true
        await refreshEntitlements()
    }

    func refreshEntitlements() async {
        var plus = false
        var active: String?
        var renews: Date?
        for await result in Transaction.currentEntitlements {
            guard case .verified(let t) = result, Self.productIDs.contains(t.productID), t.revocationDate == nil else { continue }
            plus = true
            active = t.productID
            renews = t.expirationDate
        }
        if AppSettings.isDemo && UserDefaults.standard.bool(forKey: "HaptuneDemoPlus") { plus = true; active = Self.yearly }
        if Self.isTestBuild { plus = true; active = Self.tester; renews = nil }
        isPlus = plus
        activeProductID = active
        renewalDate = renews
    }

    /// Handles the result of SwiftUI's `purchase` action (or `product.purchase()`).
    func handle(_ result: Product.PurchaseResult) async -> Bool {
        switch result {
        case .success(let verification):
            switch verification {
            case .verified(let t):
                await t.finish()
                await refreshEntitlements()
                return true
            case .unverified:
                message = String(localized: "The App Store could not verify this purchase.")
                return false
            }
        case .pending:
            message = String(localized: "Your purchase is waiting for approval (Ask to Buy).")
            return false
        case .userCancelled:
            return false
        @unknown default:
            return false
        }
    }

    func restore() async {
        do {
            try await AppStore.sync()
        } catch {
            message = error.localizedDescription
        }
        await refreshEntitlements()
        if !isPlus { message = String(localized: "No previous purchases were found for this Apple Account.") }
    }

    func product(_ id: String) -> Product? { products.first { $0.id == id } }

    var activePlanName: String {
        switch activeProductID {
        case Self.yearly: return String(localized: "Yearly")
        case Self.monthly: return String(localized: "Monthly")
        case Self.lifetime: return String(localized: "Lifetime")
        case Self.tester: return String(localized: "Test Build")
        default: return ""
        }
    }
}

/// What Plus unlocks, and the small free allowance that lets people try each feature first.
enum PlusFeature: String, Identifiable {
    case bandSplit, scan, transcribe, fullReport

    var id: String { rawValue }

    /// Free uses before the paywall (per device).
    var freeUses: Int {
        switch self {
        case .bandSplit: return 1
        case .scan: return 3
        case .transcribe: return 1
        case .fullReport: return 3
        }
    }

    var title: LocalizedStringKey {
        switch self {
        case .bandSplit: return "Band Split"
        case .scan: return "Scan Sheet Music"
        case .transcribe: return "Recording to Sheet Music"
        case .fullReport: return "Full Analysis"
        }
    }

    private var key: String { "free.\(rawValue)" }
    var used: Int { UserDefaults.standard.integer(forKey: key) }
    var remaining: Int { max(0, freeUses - used) }
    func consume() { UserDefaults.standard.set(used + 1, forKey: key) }
}
