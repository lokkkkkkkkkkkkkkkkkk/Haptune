import Charts
import PracticeCore
import SwiftUI

/// The first tab: today's practice at a glance, laid out like the Health app's Summary.
struct SummaryView: View {
    @EnvironmentObject var library: Library
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var router: Router
    @EnvironmentObject var store: Store
    @ObservedObject private var watch = WatchLink.shared
    @Environment(\.horizontalSizeClass) private var hSize

    private var stats: PracticeStats { PracticeStats(history: library.history) }
    private var columns: [GridItem] {
        hSize == .regular ? [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)] : [GridItem(.flexible())]
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HapiSays(text: library.items.isEmpty ? "Hi, I'm Hapi! Add a song and let's practise together."
                                                         : "Welcome back! A few minutes today keeps your streak going.",
                             mood: library.items.isEmpty ? .happy : .cheer)
                        .padding(.top, 4)
                    if library.items.isEmpty { WelcomeCard() }
                    SectionTitle(title: "Pinned")
                    LazyVGrid(columns: columns, spacing: 12) {
                        NavigationLink { HistoryView(metric: .time) } label: { timeCard }.buttonStyle(.plain)
                        NavigationLink { HistoryView(metric: .time) } label: { streakCard }.buttonStyle(.plain)
                        NavigationLink { HistoryView(metric: .accuracy) } label: { accuracyCard }.buttonStyle(.plain)
                        NavigationLink { HistoryView(metric: .intonation) } label: { intonationCard }.buttonStyle(.plain)
                        if let item = continueItem {
                            Button { router.open(item) } label: { continueCard(item) }.buttonStyle(.plain)
                        }
                        if WatchLink.isSupported && !watch.isWatchAppInstalled {
                            watchCard
                        }
                    }
                    if !stats.highlights.isEmpty {
                        SectionTitle(title: "Highlights")
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(stats.highlights) { h in highlightCard(h) }
                        }
                    }
                    if !store.isPlus {
                        plusCard.padding(.top, 8)
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
            }
            .background { HaptuneBackground() }
            .navigationTitle("Summary")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { ProfileButton() }
            }
        }
    }

    private var continueItem: LibraryItem? {
        library.items.filter { $0.lastPracticed != nil }.max { ($0.lastPracticed ?? .distantPast) < ($1.lastPracticed ?? .distantPast) }
            ?? library.items.first
    }

    // MARK: cards

    private var timeCard: some View {
        let today = stats.todayMinutes
        return SummaryCard(title: "Practice Time", symbol: "timer", tint: .pink, detail: String(localized: "Today")) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 2) {
                    BigValue(value: "\(Int(today.rounded()))", unit: String(localized: "min"))
                    Text("Goal \(settings.dailyGoalMinutes) min").font(.footnote).foregroundStyle(.secondary)
                }
                Spacer()
                Chart(stats.lastDays(7)) { d in
                    BarMark(x: .value("Day", d.date, unit: .day), y: .value("Minutes", d.minutes))
                        .foregroundStyle(Calendar.current.isDateInToday(d.date) ? Color.pink : Color.pink.opacity(0.35))
                        .cornerRadius(2)
                }
                .chartXAxis(.hidden)
                .chartYAxis(.hidden)
                .frame(width: 120, height: 44)
            }
            ProgressView(value: min(1, today / Double(max(1, settings.dailyGoalMinutes))))
                .tint(.pink)
        }
    }

    private var streakCard: some View {
        let s = stats.streak
        return SummaryCard(title: "Streak", symbol: "flame.fill", tint: .orange) {
            BigValue(value: "\(s)", unit: s == 1 ? String(localized: "day") : String(localized: "days"))
            Group {
                if stats.todayMinutes > 0 { Text("You practised today. Nice.") } else { Text("Practise today to keep it going.") }
            }
            .font(.footnote).foregroundStyle(.secondary)
        }
    }

    private var accuracyCard: some View {
        let takes = stats.recentTakes(12)
        let last = stats.lastTake
        return SummaryCard(title: "Accuracy", symbol: "checkmark.seal.fill", tint: .green,
                           detail: last.map { $0.date.formatted(.relative(presentation: .named)) }) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 2) {
                    BigValue(value: last.map { "\(Int(($0.accuracy * 100).rounded()))" } ?? "–", unit: "%")
                    Text(last.map { $0.title } ?? String(localized: "No takes yet"))
                        .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                if takes.count >= 2 {
                    Chart(Array(takes.enumerated()), id: \.offset) { i, r in
                        LineMark(x: .value("Take", i), y: .value("Accuracy", r.accuracy * 100))
                            .interpolationMethod(.catmullRom)
                            .foregroundStyle(Color.green)
                        PointMark(x: .value("Take", i), y: .value("Accuracy", r.accuracy * 100))
                            .foregroundStyle(Color.green)
                            .symbolSize(i == takes.count - 1 ? 30 : 0)
                    }
                    .chartXAxis(.hidden)
                    .chartYAxis(.hidden)
                    .chartYScale(domain: 40...100)
                    .frame(width: 120, height: 44)
                }
            }
        }
    }

    private var intonationCard: some View {
        SummaryCard(title: "In Tune", symbol: "tuningfork", tint: .purple, detail: String(localized: "7 days")) {
            BigValue(value: stats.inTuneRate.map { "\(Int(($0 * 100).rounded()))" } ?? "–", unit: "%")
            if let t = stats.timingPer100 {
                Text("Timing slips: \(String(format: "%.1f", t)) per 100 notes").font(.footnote).foregroundStyle(.secondary)
            } else {
                Text("Of the notes you played this week").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private func continueCard(_ item: LibraryItem) -> some View {
        SummaryCard(title: "Continue Practising", symbol: "play.circle.fill", tint: .blue,
                    detail: item.lastPracticed.map { $0.formatted(.relative(presentation: .named)) }) {
            HStack(spacing: 12) {
                IconBadge(symbol: InstrumentStyle.symbol(for: item), color: InstrumentStyle.color(for: item), size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).font(.headline).lineLimit(1)
                    Group {
                        if let bar = item.lastBar, let best = item.bestScore {
                            let pct = "\(best)%"
                            Text("Bar \(bar) · best \(pct)")
                        } else {
                            Text(InstrumentLibrary.profile(item.instrument).name)
                        }
                    }
                    .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var watchCard: some View {
        SummaryCard(title: "Apple Watch", symbol: "applewatch", tint: .gray, showsChevron: false) {
            Text("Install Melovyn on your Apple Watch to feel a tap the moment a note is wrong, sharp, flat, rushed or dragged.")
                .font(.subheadline)
        }
    }

    private func highlightCard(_ h: PracticeStats.Highlight) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: h.symbol).font(.title3).foregroundStyle(.tint).frame(width: 28)
            Text(h.text).font(.subheadline).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var plusCard: some View {
        Button { router.paywall = .bandSplit } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: "sparkles")
                    Text("Melovyn Plus").font(.headline)
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
                }
                Text("Split band recordings into parts, scan printed music, sync with iCloud and get full reports.")
                    .font(.subheadline)
                    .multilineTextAlignment(.leading)
                Text("Try it free for a week").font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(.white)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(LinearGradient(colors: [.purple, .pink], startPoint: .topLeading, endPoint: .bottomTrailing),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

/// Initials in a circle, top right (like the Health app's profile picture).
struct ProfileButton: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var router: Router
    @EnvironmentObject var store: Store

    var body: some View {
        Button { router.showAccount = true } label: {
            ZStack(alignment: .bottomTrailing) {
                if settings.initials.isEmpty {
                    Image(systemName: "person.crop.circle.fill").font(.title2).symbolRenderingMode(.hierarchical)
                } else {
                    Text(settings.initials)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(width: 32, height: 32)
                        .background(Color.accentColor.gradient, in: Circle())
                }
                if store.isPlus {
                    Image(systemName: "crown.fill").font(.system(size: 9)).foregroundStyle(.yellow)
                        .padding(2).background(Circle().fill(Color(uiColor: .systemBackground)))
                        .offset(x: 3, y: 3)
                }
            }
        }
        .accessibilityLabel(Text("Account and Settings"))
    }
}

/// First run: what Melovyn does, in three steps.
struct WelcomeCard: View {
    @EnvironmentObject var library: Library
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var router: Router

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Welcome to Melovyn").font(.title2.weight(.bold))
            step("music.note.list", .blue, "Add a piece", "MusicXML, MIDI, a PDF or photo of sheet music, jianpu, or a recording.")
            step("applewatch", .gray, "Wear your Apple Watch", "Your wrist taps you the moment a note is wrong, sharp, flat, rushed or dragged.")
            step("chart.bar.fill", .green, "See what to fix", "Every take shows the bars to loop and how to practise them.")
            HStack {
                Button { router.tab = .library } label: { Text("Add a Piece").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
                Button {
                    DemoData.addSamplePieces(to: library, instrument: settings.instrument)
                } label: { Text("Try Samples").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
            }
            .controlSize(.large)
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.top, 8)
    }

    private func step(_ symbol: String, _ color: Color, _ title: LocalizedStringKey, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 12) {
            IconBadge(symbol: symbol, color: color, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(text).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// All takes, with a chart for the chosen measure.
struct HistoryView: View {
    enum Metric: String, CaseIterable, Identifiable {
        case time, accuracy, intonation
        var id: String { rawValue }
        var title: LocalizedStringKey {
            switch self {
            case .time: return "Time"
            case .accuracy: return "Accuracy"
            case .intonation: return "In Tune"
            }
        }
    }

    @EnvironmentObject var library: Library
    @State var metric: Metric

    var body: some View {
        let stats = PracticeStats(history: library.history)
        List {
            Section {
                Picker("Measure", selection: $metric) {
                    ForEach(Metric.allCases) { m in Text(m.title).tag(m) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                chart(stats).frame(height: 200).padding(.vertical, 8)
            }
            Section("Takes") {
                if library.history.isEmpty {
                    Text("Your takes will appear here.").foregroundStyle(.secondary)
                }
                ForEach(library.history.reversed()) { r in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.title).font(.body)
                            Text(r.date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(verbatim: "\(Int((r.accuracy * 100).rounded()))%").font(.body.monospacedDigit().weight(.semibold))
                            Text("\(Int((r.seconds / 60).rounded())) min").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder private func chart(_ stats: PracticeStats) -> some View {
        switch metric {
        case .time:
            Chart(stats.lastDays(14)) { d in
                BarMark(x: .value("Day", d.date, unit: .day), y: .value("Minutes", d.minutes))
                    .foregroundStyle(Color.pink.gradient)
            }
        case .accuracy:
            Chart(Array(stats.recentTakes(30).enumerated()), id: \.offset) { i, r in
                LineMark(x: .value("Take", i + 1), y: .value("Accuracy", r.accuracy * 100))
                    .foregroundStyle(Color.green)
                PointMark(x: .value("Take", i + 1), y: .value("Accuracy", r.accuracy * 100))
                    .foregroundStyle(Color.green)
            }
            .chartYScale(domain: 0...100)
        case .intonation:
            Chart(Array(stats.recentTakes(30).enumerated()), id: \.offset) { i, r in
                BarMark(x: .value("Take", i + 1), y: .value("In tune", r.inTune * 100))
                    .foregroundStyle(Color.purple.gradient)
            }
            .chartYScale(domain: 0...100)
        }
    }
}
