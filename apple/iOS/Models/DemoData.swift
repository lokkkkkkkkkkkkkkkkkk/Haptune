import Foundation
import PracticeCore

/// Sample pieces and two weeks of practice history, used for the first-run "Try a sample" button,
/// App Store screenshots and the CI screenshots (`-HaptuneDemo YES`).
enum DemoData {
    static let trioTitle = "Minuet Trio (demo)"

    static let odeToJoy = """
    title: 欢乐颂 Ode to Joy
    key: 1=D
    time: 4/4
    tempo: 100
    ---
    3 3 4 5 | 5 4 3 2 | 1 1 2 3 | 3. 2_ 2 - |
    3 3 4 5 | 5 4 3 2 | 1 1 2 3 | 2. 1_ 1 - ||
    """

    @MainActor
    static func addSamplePieces(to library: Library, instrument: InstrumentProfile) {
        if let url = Bundle.main.url(forResource: "Demo-Minuet", withExtension: "musicxml"),
           let data = try? Data(contentsOf: url),
           let s = try? MusicXMLParser.parse(data: data, fallbackTitle: "Minuet in G") {
            _ = try? library.add(score: s, musicXML: String(decoding: data, as: UTF8.self), instrument: "violin", kind: "musicxml")
        }
        if let s = try? Jianpu.parse(odeToJoy, instrument: "erhu") {
            _ = try? library.add(score: s, musicXML: MusicXMLWriter.write(s), instrument: "erhu", kind: "jianpu")
        }
        let scale = Exercises.scale(tonic: "D", kind: "major", octaves: 2, instrument: instrument, qpm: 80)
        _ = try? library.add(score: scale, musicXML: MusicXMLWriter.write(scale), instrument: instrument.key, kind: "exercise")
    }

    /// Fills an empty library for screenshots: pieces, a band split and 14 days of takes.
    @MainActor
    static func seedIfNeeded(library: Library, splits: SplitCenter, settings: AppSettings) {
        guard AppSettings.isDemo, library.items.isEmpty else { return }
        if settings.displayName.isEmpty { settings.displayName = "Alex Tan" }
        addSamplePieces(to: library, instrument: settings.instrument)
        _ = splits.addDemo(to: library)
        let pieces = library.items
        guard !pieces.isEmpty else { return }
        var rng = SeededRandom(seed: 7)
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        for back in (0..<14).reversed() {
            if back == 9 || back == 5 { continue }                       // a couple of rest days
            guard let day = cal.date(byAdding: .day, value: -back, to: today) else { continue }
            let sessions = back == 0 ? 2 : 1 + Int(rng.next() * 2)
            for k in 0..<sessions {
                let piece = pieces[(back + k) % pieces.count]
                let progress = Double(14 - back) / 14
                let total = 40 + Int(rng.next() * 40)
                let acc = min(0.98, 0.70 + 0.22 * progress + rng.next() * 0.05)
                let correct = Int(Double(total) * acc)
                let wrong = Int(Double(total - correct) * 0.6)
                let date = day.addingTimeInterval(Double(17 * 3600 + k * 2400) + rng.next() * 1800)
                library.record(PracticeRecord(itemID: piece.id, title: piece.title, instrument: piece.instrument, date: date,
                                              seconds: 300 + rng.next() * 900, correct: correct, wrong: wrong,
                                              missed: total - correct - wrong, total: total,
                                              outOfTune: Int(Double(total) * (0.12 - 0.08 * progress)),
                                              timing: Int(rng.next() * 4), mode: "follow", tempoPercent: 80 + 5 * Int(progress * 4)))
            }
        }
        if var first = library.items.first(where: { $0.sourceKind == "musicxml" }) {
            first.lastPracticed = Date()
            first.lastBar = "9"
            first.bestScore = 94
            first.favorite = true
            library.update(first)
        }
    }
}

/// Small deterministic generator so screenshots look the same on every run.
struct SeededRandom {
    private var state: UInt64
    init(seed: UInt64) { state = seed &* 0x9E3779B97F4A7C15 }
    mutating func next() -> Double {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return Double(state >> 11) / Double(1 << 53)
    }
}
