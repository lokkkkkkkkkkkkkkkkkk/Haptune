import StoreKit
import SwiftUI

/// Melovyn Plus: what it unlocks, three plans, and Apple's own payment sheet.
struct PaywallView: View {
    var highlight: PlusFeature?
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.purchase) private var purchase
    @State private var selected = Store.yearly
    @State private var busy = false
    @State private var note: String?

    private struct Plan: Identifiable {
        let id: String
        let title: LocalizedStringKey
        let price: String
        let period: LocalizedStringKey
        let detail: LocalizedStringKey?
        let badge: LocalizedStringKey?
        let product: Product?
    }

    private var plans: [Plan] {
        // Real prices come from the App Store; the fallbacks only show while products are loading or
        // when the build has no App Store / StoreKit configuration (screenshots, CI).
        [Plan(id: Store.yearly, title: "Yearly", price: store.product(Store.yearly)?.displayPrice ?? "US$24.99",
              period: "per year", detail: "1 week free, then billed once a year", badge: "Best Value",
              product: store.product(Store.yearly)),
         Plan(id: Store.monthly, title: "Monthly", price: store.product(Store.monthly)?.displayPrice ?? "US$3.99",
              period: "per month", detail: nil, badge: nil, product: store.product(Store.monthly)),
         Plan(id: Store.lifetime, title: "Lifetime", price: store.product(Store.lifetime)?.displayPrice ?? "US$59.99",
              period: "one time", detail: "Pay once, keep Plus forever", badge: nil, product: store.product(Store.lifetime))]
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    header
                    VStack(alignment: .leading, spacing: 16) {
                        feature(.bandSplit, "slider.vertical.3", .purple, "Band Split",
                                "Turn a band recording into a part, a practice track and sheet music for every instrument.")
                        feature(.scan, "doc.viewfinder", .blue, "Scan Sheet Music",
                                "Photograph or scan printed music and practise it with your Watch.")
                        feature(.transcribe, "waveform.badge.magnifyingglass", .orange, "Recording to Sheet Music",
                                "Your teacher plays it once; Melovyn writes it down.")
                        feature(.fullReport, "chart.bar.doc.horizontal", .green, "Full Analysis",
                                "Coloured score, tempo and intonation charts and a practice plan after every take.")
                    }
                    .padding(16)
                    .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                    VStack(spacing: 10) {
                        ForEach(plans) { plan in planRow(plan) }
                    }

                    Button {
                        Task { await buy() }
                    } label: {
                        HStack {
                            if busy { ProgressView().tint(.white) }
                            if selected == Store.yearly { Text("Start Free Week") } else { Text("Continue") }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(busy)

                    VStack(spacing: 6) {
                        Text("Cancel any time in Settings. Family Sharing included. Practice, the tuner, metronome and Watch feedback stay free.")
                            .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        if let note { Text(note).font(.footnote).foregroundStyle(.orange).multilineTextAlignment(.center) }
                        Button("Restore Purchases") { Task { await store.restore() } }
                            .font(.footnote)
                    }
                }
                .padding()
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark.circle.fill").symbolRenderingMode(.hierarchical) }
                        .accessibilityLabel(Text("Close"))
                }
            }
            .onChange(of: store.isPlus) { _, plus in if plus { dismiss() } }
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Image(systemName: "sparkles")
                .font(.system(size: 40, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 84, height: 84)
                .background(LinearGradient(colors: [.purple, .pink], startPoint: .topLeading, endPoint: .bottomTrailing),
                            in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            Text("Melovyn Plus").font(.largeTitle.weight(.bold))
            Text("Learn a piece from any recording, not just play it.")
                .font(.title3).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(.top, 8)
    }

    private func feature(_ f: PlusFeature, _ symbol: String, _ color: Color, _ title: LocalizedStringKey, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 12) {
            IconBadge(symbol: symbol, color: color, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(text).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .background(highlight == f ? color.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func planRow(_ plan: Plan) -> some View {
        let on = selected == plan.id
        return Button { selected = plan.id } label: {
            HStack(spacing: 12) {
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .font(.title2)
                    .foregroundStyle(on ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(plan.title).font(.headline)
                        if let badge = plan.badge {
                            Text(badge).font(.caption2.weight(.bold)).padding(.horizontal, 6).padding(.vertical, 2)
                                .foregroundStyle(.white).background(Color.accentColor, in: Capsule())
                        }
                    }
                    if let d = plan.detail { Text(d).font(.footnote).foregroundStyle(.secondary) }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 0) {
                    Text(verbatim: plan.price).font(.headline.monospacedDigit())
                    Text(plan.period).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(14)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(on ? Color.accentColor : Color.clear, lineWidth: 2))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func buy() async {
        guard let product = store.product(selected) else {
            note = String(localized: "Purchases aren't available in this build yet. In Xcode, run with the Haptune.storekit configuration to test them.")
            return
        }
        busy = true
        defer { busy = false }
        do {
            let result = try await purchase(product)
            if await store.handle(result) { dismiss() }
        } catch {
            note = error.localizedDescription
        }
    }
}
