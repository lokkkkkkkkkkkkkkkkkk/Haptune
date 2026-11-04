import Combine
import PracticeCore
import SwiftUI

struct PracticeView: View {
    let item: LibraryItem
    let score: PracticeScore
    let musicXML: String
    /// Set when practising one part of a band split (the other parts can play along).
    var part: SplitPart?

    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var library: Library
    @EnvironmentObject var store: Store
    @EnvironmentObject var router: Router
    @StateObject private var bridge = ScoreBridge()
    @StateObject private var holder = SessionHolder()
    @StateObject private var band = StemPlayer()
    @ObservedObject private var watch = WatchLink.shared
    @State private var mode: ScoreFollower.Mode = .follow
    @State private var tempoPercent = 100.0
    @State private var loopOn = false
    @State private var loopFrom = 0
    @State private var loopTo = 0
    @State private var withBand = false
    @State private var showReport = false

    private var baseQPM: Double { score.firstTempo }
    private var qpm: Double { (baseQPM * tempoPercent / 100).rounded() }
    private var running: Bool { holder.session?.running ?? false }

    var body: some View {
        ScoreWebView(bridge: bridge, musicXML: musicXML)
            .ignoresSafeArea(edges: .bottom)
            .overlay(alignment: .topTrailing) { liveBadge.padding(12) }
            .safeAreaInset(edge: .bottom, spacing: 0) { controls }
            .navigationTitle(part.map { "\(item.title) · \($0.name)" } ?? item.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showReport = true } label: { Label("Take Report", systemImage: "chart.bar.doc.horizontal") }
                        .disabled(holder.session?.summary == nil)
                }
            }
            .sheet(isPresented: $showReport) {
                if let s = holder.session { ReportView(session: s, item: item, score: score) }
            }
            .onAppear(perform: setUp)
            .onDisappear {
                holder.session?.stop()
                band.stop()
            }
            .onChange(of: bridge.tappedQuarter) { _, q in
                // tap a note to loop from its bar
                guard let q, !running else { return }
                let idx = score.measures.lastIndex(where: { $0.start <= q + 1e-6 }) ?? 0
                loopOn = true
                loopFrom = idx
                loopTo = min(score.measures.count - 1, idx + 1)
            }
            .alert("Can't Start", isPresented: Binding(get: { holder.session?.errorMessage != nil },
                                                      set: { if !$0 { holder.session?.errorMessage = nil } })) {
                Button("OK", role: .cancel) { holder.session?.errorMessage = nil }
            } message: {
                Text(holder.session?.errorMessage ?? "")
            }
    }

    private func setUp() {
        if holder.session == nil { holder.session = PracticeSession(score: score, item: item, bridge: bridge) }
        loopTo = max(0, min(3, score.measures.count - 1))
        if let part, let split = item.split {
            let others = split.parts.filter { $0.id != part.id }.map { (id: $0.id, url: library.stemURL($0, of: item)) }
            band.load(others)
            withBand = band.isLoaded
        }
        WatchLink.shared.onCommand = { cmd in
            switch cmd {
            case .start: toggle()
            case .stop: holder.session?.stop()
            case .restartLoop: restart()
            case .toggleMetronome: mode = mode == .tempo ? .follow : .tempo
            case .nextMode:
                let all = ScoreFollower.Mode.allCases
                mode = all[((all.firstIndex(of: mode) ?? 0) + 1) % all.count]
            }
        }
    }

    // MARK: live badge

    @ViewBuilder private var liveBadge: some View {
        if let s = holder.session, s.running {
            VStack(alignment: .trailing, spacing: 4) {
                Text("Bar \(s.currentBar)").font(.headline.monospacedDigit())
                if let e = s.lastEvent, e.isCorrective {
                    Label(e.text.isEmpty ? e.kind.rawValue : e.text, systemImage: e.spec.glyph)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(e.kind == .wrongNote ? Color.red : Color.orange)
                }
            }
            .padding(10)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    // MARK: controls

    private var controls: some View {
        VStack(spacing: 12) {
            if !withBand {
                Picker("Mode", selection: $mode) {
                    Text("Follow Me").tag(ScoreFollower.Mode.follow)
                    Text("Wait for Me").tag(ScoreFollower.Mode.wait)
                    Text("Metronome").tag(ScoreFollower.Mode.tempo)
                }
                .pickerStyle(.segmented)
                .disabled(running)
            }

            HStack(spacing: 10) {
                Image(systemName: "tortoise.fill").foregroundStyle(.secondary)
                Slider(value: $tempoPercent, in: 40...130, step: 5)
                Image(systemName: "hare.fill").foregroundStyle(.secondary)
                Text("\(Int(qpm)) BPM").font(.callout.monospacedDigit()).frame(minWidth: 70, alignment: .trailing)
            }
            .disabled(running)

            HStack {
                Toggle(isOn: $loopOn) { Label("Loop", systemImage: "repeat") }
                    .toggleStyle(.button)
                if loopOn {
                    Stepper {
                        Text("Bars \(score.measureLabel(loopFrom))–\(score.measureLabel(loopTo))").font(.callout.monospacedDigit())
                    } onIncrement: {
                        loopTo = min(score.measures.count - 1, loopTo + 1)
                    } onDecrement: {
                        loopTo = max(loopFrom, loopTo - 1)
                    }
                }
                Spacer()
                if band.isLoaded {
                    Toggle(isOn: $withBand) { Label("Band", systemImage: "speaker.wave.2.fill") }
                        .toggleStyle(.button)
                }
            }
            .disabled(running)

            HStack {
                watchStatus.frame(width: 60, alignment: .leading)
                Spacer()
                Button(action: toggle) {
                    Image(systemName: running ? "stop.fill" : "play.fill")
                        .font(.system(size: 28, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 72, height: 72)
                        .background(Circle().fill(running ? Color.red : Color.accentColor))
                        .shadow(color: .black.opacity(0.15), radius: 6, y: 3)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(running ? Text("Stop") : Text("Start"))
                .sensoryFeedback(.impact, trigger: running)
                Spacer()
                Group {
                    if let s = holder.session?.summary, s.total > 0 {
                        Button { showReport = true } label: {
                            VStack(spacing: 0) {
                                Text(verbatim: "\(Int(Double(s.correct) / Double(s.total) * 100))%").font(.headline.monospacedDigit())
                                Text("last take").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    } else {
                        Color.clear
                    }
                }
                .frame(width: 60, height: 40, alignment: .trailing)
            }
            if withBand {
                Label("Use headphones so the microphone hears only you.", systemImage: "headphones")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .background(.bar)
    }

    private var watchStatus: some View {
        Group {
            if WatchLink.isSupported {
                Image(systemName: watch.isReachable ? "applewatch.radiowaves.left.and.right" : "applewatch.slash")
                    .font(.title2)
                    .foregroundStyle(watch.isReachable ? Color.green : Color.secondary)
                    .accessibilityLabel(watch.isReachable ? Text("Watch connected") : Text("Watch not connected"))
            } else {
                Color.clear.frame(width: 1, height: 1)
            }
        }
    }

    // MARK: actions

    private func makeBand() -> BandBacking? {
        guard withBand, band.isLoaded, let split = item.split else { return nil }
        let startBeat = loopOn ? (score.measures[safe: loopFrom]?.start ?? 0) : 0
        return BandBacking(player: band, audioStart: split.offset + score.beatToSeconds(startBeat), rate: Float(tempoPercent / 100))
    }

    private func toggle() {
        guard let s = holder.session else { return }
        if s.running {
            s.stop()
            saveStats()
            return
        }
        Task {
            await s.start(settings: settings, mode: mode, qpm: qpm, tempoPercent: Int(tempoPercent),
                          loop: loopOn ? loopFrom...loopTo : nil, takeURL: library.takeURL(for: item), band: makeBand())
        }
    }

    private func restart() {
        guard let s = holder.session else { return }
        s.stop()
        saveStats()
        Task {
            await s.start(settings: settings, mode: mode, qpm: qpm, tempoPercent: Int(tempoPercent),
                          loop: loopOn ? loopFrom...loopTo : nil, takeURL: library.takeURL(for: item), band: makeBand())
        }
    }

    private func saveStats() {
        guard let session = holder.session else { return }
        if let r = session.lastRecord { library.record(r) }
        guard let sum = session.summary, sum.total > 0, var it = library.item(id: item.id) else { return }
        it.lastPracticed = Date()
        it.lastBar = session.currentBar == "–" ? nil : session.currentBar
        let pct = Int((Double(sum.correct) / Double(sum.total) * 100).rounded())
        it.bestScore = max(it.bestScore ?? 0, pct)
        library.update(it)
    }
}

@MainActor
final class SessionHolder: ObservableObject {
    @Published var session: PracticeSession? {
        didSet { cancellable = session?.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() } }
    }
    private var cancellable: AnyCancellable?
}
