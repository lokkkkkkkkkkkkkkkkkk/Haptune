import Charts
import PracticeCore
import SwiftUI
import WebKit

/// After a take: bar-by-bar chart, the buzz log, and (with the server) the full analysis report.
struct ReportView: View {
    @ObservedObject var session: PracticeSession
    let item: LibraryItem
    let score: PracticeScore
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: Store
    @EnvironmentObject var router: Router
    @Environment(\.dismiss) private var dismiss
    @State private var fullReport: HTMLDoc?
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let s = session.summary {
                    Section {
                        HStack(spacing: 18) {
                            stat("\(s.total == 0 ? 0 : Int(Double(s.correct) / Double(s.total) * 100))%", "score")
                            stat("\(s.wrong)", "wrong")
                            stat("\(s.missed)", "missed")
                            stat("\(session.events.filter { $0.kind == .sharp || $0.kind == .flat }.count)", "out of tune")
                        }
                    }
                }
                Section("Bar by bar") {
                    Chart(session.bars) { b in
                        BarMark(x: .value("Bar", b.label), y: .value("Issues", b.wrong), stacking: .standard)
                            .foregroundStyle(by: .value("Kind", kWrong))
                        BarMark(x: .value("Bar", b.label), y: .value("Issues", b.missed), stacking: .standard)
                            .foregroundStyle(by: .value("Kind", kMissed))
                        BarMark(x: .value("Bar", b.label), y: .value("Issues", b.other), stacking: .standard)
                            .foregroundStyle(by: .value("Kind", kOther))
                    }
                    .chartForegroundStyleScale([kWrong: Color.red, kMissed: Color.orange, kOther: Color.indigo])
                    .frame(height: 180)
                    if let worst = session.bars.max(by: { ($0.wrong + $0.missed + $0.other) < ($1.wrong + $1.missed + $1.other) }),
                       worst.wrong + worst.missed + worst.other > 0 {
                        Label("Loop bar \(worst.label) slowly in Wait for Me mode, then speed up by 10 BPM at a time.",
                              systemImage: "repeat").font(.callout)
                    }
                }
                Section("What Your Watch Tapped") {
                    if session.events.isEmpty { Text("No taps: a clean take!").foregroundStyle(.secondary) }
                    ForEach(session.events.filter { $0.isCorrective }) { e in
                        HStack {
                            Image(systemName: e.spec.glyph).foregroundStyle(e.kind == .wrongNote ? .red : .orange)
                            Text("Bar \(e.measureLabel ?? "?")")
                            Spacer()
                            Text(e.text).foregroundStyle(.secondary)
                            Text(String(format: "%.1fs", e.time)).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                        }
                    }
                }
                Section {
                    Button {
                        router.gate(.fullReport, store: store) { Task { await analyse() } }
                    } label: {
                        HStack {
                            if loading {
                                Label("Analysing…", systemImage: "waveform.badge.magnifyingglass")
                            } else {
                                Label("Full Analysis", systemImage: "waveform.badge.magnifyingglass")
                            }
                            Spacer()
                            if !store.isPlus { PlusBadge() }
                        }
                    }
                    .disabled(settings.api == nil || loading || session.takeURL == nil)
                    if settings.api == nil {
                        Text("The full report uses Melovyn's online service, which isn't available right now.").font(.footnote).foregroundStyle(.secondary)
                    } else {
                        Text("Sheet music coloured note by note, tempo and intonation charts, and a practice plan.").font(.footnote).foregroundStyle(.secondary)
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Take Report")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(item: $fullReport) { doc in HTMLView(html: doc.html).ignoresSafeArea() }
        }
    }

    private var kWrong: String { String(localized: "Wrong") }
    private var kMissed: String { String(localized: "Missed") }
    private var kOther: String { String(localized: "Tuning / timing") }

    private func stat(_ v: String, _ k: LocalizedStringKey) -> some View {
        VStack { Text(verbatim: v).font(.title.bold().monospacedDigit()); Text(k).font(.caption).foregroundStyle(.secondary) }
            .frame(maxWidth: .infinity)
    }

    private func analyse() async {
        guard let api = settings.api, let take = session.takeURL else { return }
        loading = true
        defer { loading = false }
        do {
            let html = try await api.analyzeHTML(score: score, take: take, instrument: settings.instrumentKey,
                                                 targetQPM: nil, metronome: false, level: settings.levelRaw)
            fullReport = HTMLDoc(html: html)
        } catch { self.error = error.localizedDescription }
    }
}

struct HTMLDoc: Identifiable { let id = UUID(); let html: String }

struct HTMLView: UIViewRepresentable {
    let html: String
    func makeUIView(context: Context) -> WKWebView { let w = WKWebView(); w.loadHTMLString(html, baseURL: nil); return w }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
