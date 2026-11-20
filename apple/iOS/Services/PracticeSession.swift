import Foundation
import PracticeCore

/// Runs the follower off the main thread. Microphone chunks in, results out.
final class AnalysisPipeline: @unchecked Sendable {
    struct Update: Sendable {
        let events: [FeedbackEvent]
        let current: PracticeScore.Event?
        let finished: Bool
        let cursor: Int
        let count: Int
        let passes: Int
    }

    let follower: ScoreFollower
    private let queue = DispatchQueue(label: "practice.analysis", qos: .userInteractive)
    var onUpdate: (@Sendable (Update) -> Void)?

    init(follower: ScoreFollower) { self.follower = follower }

    func push(_ samples: [Float]) {
        queue.async {
            let out = self.follower.push(samples)
            let u = Update(events: out, current: self.follower.currentEvent, finished: self.follower.isFinished,
                           cursor: self.follower.cursor, count: self.follower.events.count, passes: self.follower.passes)
            self.onUpdate?(u)
        }
    }

    func drain() { queue.sync {} }
    func summary() -> (correct: Int, wrong: Int, missed: Int, total: Int) { queue.sync { follower.summary() } }
}

/// The recorded band you can practise with (a band split, minus your own part).
struct BandBacking {
    let player: StemPlayer
    let audioStart: Double        // where in the recording the practised passage begins (s)
    let rate: Float               // 1.0 = original tempo
}

/// One practice take: microphone -> ScoreFollower -> score highlighting, Watch buzzes, bar stats.
@MainActor
final class PracticeSession: ObservableObject {
    struct BarStat: Identifiable { let id: Int; let label: String; var wrong = 0; var missed = 0; var other = 0; var notes = 0 }
    struct Summary { var correct: Int; var wrong: Int; var missed: Int; var total: Int }

    @Published private(set) var running = false
    @Published private(set) var lastEvent: FeedbackEvent?
    @Published private(set) var events: [FeedbackEvent] = []
    @Published private(set) var currentBar = "–"
    @Published private(set) var expectedNote = ""
    @Published private(set) var progress = 0.0
    @Published private(set) var bars: [BarStat] = []
    @Published private(set) var summary: Summary?
    @Published private(set) var lastRecord: PracticeRecord?
    @Published var errorMessage: String?

    let score: PracticeScore
    let item: LibraryItem
    let bridge: ScoreBridge
    private var pipeline: AnalysisPipeline?
    private var practiceScore: PracticeScore?
    private var loopOffset = 0
    private var mode: ScoreFollower.Mode = .follow
    private var tempoPercent = 100
    private var startedAt: Date?
    private var band: BandBacking?
    private let mic = MicrophoneStream()
    private let watch = WatchLink.shared
    private var printedStart: [Int: Double] = [:]
    private(set) var takeURL: URL?

    init(score: PracticeScore, item: LibraryItem, bridge: ScoreBridge) {
        self.score = score
        self.item = item
        self.bridge = bridge
        var pos = 0.0
        for m in score.measures.sorted(by: { $0.sourceIndex < $1.sourceIndex }) where printedStart[m.sourceIndex] == nil {
            printedStart[m.sourceIndex] = pos
            pos += m.duration
        }
    }

    /// A beat inside the practised slice -> printed quarter position (what Verovio's timemap uses).
    private func printedQuarter(sliceBeat: Double, sliceMeasure: Int) -> Double {
        let measure = sliceMeasure + loopOffset
        let base = score.measures[safe: loopOffset]?.start ?? 0
        guard let m = score.measures[safe: measure] else { return sliceBeat + base }
        return (printedStart[m.sourceIndex] ?? m.start) + (sliceBeat + base - m.start)
    }

    func start(settings: AppSettings, mode requested: ScoreFollower.Mode, qpm: Double, tempoPercent: Int,
               loop: ClosedRange<Int>?, takeURL: URL, band: BandBacking? = nil) async {
        guard !running else { return }
        guard await MicrophoneStream.requestPermission() else {
            errorMessage = String(localized: "Haptune needs the microphone to hear you play. Turn it on in Settings > Privacy & Security > Microphone.")
            return
        }
        let mode: ScoreFollower.Mode = band == nil ? requested : .tempo          // the band never waits
        let ps = loop.map { score.slice(measures: $0.lowerBound, $0.upperBound) } ?? score
        loopOffset = loop?.lowerBound ?? 0
        practiceScore = ps
        self.mode = mode
        self.tempoPercent = tempoPercent
        self.band = band
        let f = ScoreFollower(score: ps, instrument: settings.instrument, mode: mode, qpm: qpm, a4: settings.a4,
                              sensitivity: settings.sensitivity,
                              loop: loop == nil ? nil : 0...max(0, ps.measures.count - 1), level: settings.level)
        let beatsPerBar = ps.measures.first?.timeSignature.first ?? 4
        let countIn = (mode == .tempo && band == nil) ? settings.countInBars * beatsPerBar : 0
        let startAt = Date().addingTimeInterval(1.0)
        if let band {
            // the band starts two beats before the passage, 1 s after the microphone
            let lead = 2 * 60.0 / max(20, qpm) * Double(band.rate)
            let from = max(0, band.audioStart - lead)
            f.metronomeStart = 1.0 + (band.audioStart - from) / Double(band.rate)
        } else {
            f.metronomeStart = 1.0 + Double(countIn) * 60 / qpm
        }
        let pipe = AnalysisPipeline(follower: f)
        pipe.onUpdate = { [weak self] u in Task { @MainActor in self?.apply(u) } }
        pipeline = pipe
        events = []
        lastEvent = nil
        summary = nil
        lastRecord = nil
        progress = 0
        bars = ps.measures.map { m in BarStat(id: m.index, label: m.label, notes: ps.notes.filter { $0.measure == m.index }.count) }
        bridge.clearMarks()
        self.takeURL = takeURL
        try? FileManager.default.removeItem(at: takeURL)
        mic.onSamples = { [pipe] samples in pipe.push(samples) }
        do {
            try mic.start(recordingTo: takeURL)
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        if let band {
            band.player.rate = band.rate
            let lead = 2 * 60.0 / max(20, qpm) * Double(band.rate)
            band.player.play(from: max(0, band.audioStart - lead), delay: 1.0)
        }
        running = true
        startedAt = Date()
        watch.send(WatchEnvelope(kind: .session, session: .init(title: score.title, instrument: settings.instrument.name,
                                                                mode: mode.rawValue, running: true)))
        watch.send(WatchEnvelope(kind: .metronome, metronome: .init(enabled: mode == .tempo && band == nil, bpm: qpm,
                                                                    beatsPerBar: beatsPerBar, startAt: startAt,
                                                                    countInBeats: countIn)))
    }

    func stop() {
        guard running else { return }
        mic.stop()
        mic.onSamples = nil
        band?.player.pause()
        running = false
        if let pipe = pipeline {
            pipe.drain()
            let s = pipe.summary()
            summary = Summary(correct: s.correct, wrong: s.wrong, missed: s.missed, total: s.total)
            watch.send(WatchEnvelope(kind: .summary, summary: .init(correct: s.correct, wrong: s.wrong, missed: s.missed, total: s.total)))
            let seconds = startedAt.map { Date().timeIntervalSince($0) } ?? 0
            if seconds >= 5 {
                lastRecord = PracticeRecord(
                    itemID: item.id, title: item.title, instrument: item.instrument, date: Date(), seconds: seconds,
                    correct: s.correct, wrong: s.wrong, missed: s.missed, total: s.total,
                    outOfTune: events.filter { $0.kind == .sharp || $0.kind == .flat }.count,
                    timing: events.filter { $0.kind == .rushing || $0.kind == .dragging }.count,
                    mode: mode.rawValue, tempoPercent: tempoPercent)
            }
        }
        watch.send(WatchEnvelope(kind: .session, session: .init(title: score.title, instrument: "", mode: "", running: false)))
        watch.send(WatchEnvelope(kind: .metronome, metronome: .init(enabled: false, bpm: 0, beatsPerBar: 4, startAt: Date(), countInBeats: 0)))
    }

    private func apply(_ u: AnalysisPipeline.Update) {
        guard let ps = practiceScore else { return }
        for e in u.events {
            events.append(e)
            lastEvent = e
            watch.send(.feedback(e))
            if let m = e.measure, let i = bars.firstIndex(where: { $0.id == m }) {
                switch e.kind {
                case .wrongNote: bars[i].wrong += 1
                case .missedNote: bars[i].missed += 1
                case .sharp, .flat, .rushing, .dragging: bars[i].other += 1
                default: break
                }
            }
            let kind: String? = [FeedbackEvent.Kind.wrongNote: "wrong", .missedNote: "missed", .sharp: "sharp", .flat: "flat"][e.kind]
            if let kind, let note = ps.notes.first(where: { $0.id == e.noteID }) {
                bridge.mark(quarter: printedQuarter(sliceBeat: note.onset, sliceMeasure: note.measure),
                            midi: note.written ?? note.pitch, kind: kind)
            }
        }
        if let ev = u.current {
            let m = ev.measure + loopOffset
            currentBar = score.measureLabel(m)
            expectedNote = NoteName.name(ev.pitches.last, preferFlats: (score.measures[safe: m]?.keyFifths ?? 0) < 0)
            bridge.cursor(quarter: printedQuarter(sliceBeat: ev.onset, sliceMeasure: ev.measure))
            watch.send(WatchEnvelope(kind: .position, position: .init(measureLabel: currentBar, expectedNote: expectedNote)))
        }
        if u.count > 0 { progress = Double(u.cursor) / Double(u.count) }
        // a single pass that reached the last note ends the take (loops keep going)
        if running && u.finished && mode != .wait && u.passes > 0 && u.cursor >= u.count { stop() }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
