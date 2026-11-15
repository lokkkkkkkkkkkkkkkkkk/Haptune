import Foundation
import PracticeCore
import WatchConnectivity
import WatchKit

/// Watch side: receives decisions from the iPhone and turns them into taps on the wrist.
@MainActor
final class WatchCoach: NSObject, ObservableObject {
    @Published var title = "Melovyn"
    @Published var running = false
    @Published var bar = "–"
    @Published var expected = ""
    @Published var glyph = "music.note"
    @Published var message = String(localized: "Start a piece on your iPhone")
    @Published var lastKind: FeedbackEvent.Kind?
    @Published var summary: WatchEnvelope.Summary?
    @Published var hapticsOn = true
    let metronome = HapticMetronome()

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func send(_ c: WatchEnvelope.Command) {
        guard WCSession.default.isReachable, let d = WatchEnvelope.command(c).encoded() else { return }
        WCSession.default.sendMessageData(d, replyHandler: nil, errorHandler: nil)
    }

    func handle(_ env: WatchEnvelope) {
        switch env.kind {
        case .feedback:
            guard let e = env.feedback else { return }
            lastKind = e.kind
            glyph = e.spec.glyph
            message = text(for: e)
            if let l = e.measureLabel { bar = l }
            if hapticsOn { Haptics.play(e.spec.watchHaptic) }
        case .position:
            if let p = env.position { bar = p.measureLabel; expected = p.expectedNote }
        case .session:
            guard let s = env.session else { return }
            running = s.running
            if s.running {
                title = s.title; summary = nil; glyph = "ear"; message = String(localized: "Listening…")
            } else {
                glyph = "checkmark.circle"; message = String(localized: "Take finished")
            }
        case .metronome:
            guard let m = env.metronome else { return }
            if m.enabled { metronome.start(bpm: m.bpm, beatsPerBar: m.beatsPerBar, at: m.startAt, countIn: m.countInBeats) }
            else { metronome.stop() }
        case .summary:
            summary = env.summary
        case .command:
            break
        }
    }

    private func text(for e: FeedbackEvent) -> String {
        switch e.kind {
        case .wrongNote: return e.expected.map { String(localized: "Play \(NoteName.name($0))") } ?? String(localized: "Wrong note")
        case .missedNote: return String(localized: "Missed \(e.text)")
        case .sharp: return String(localized: "Sharp \(e.text): go lower")
        case .flat: return String(localized: "Flat \(e.text): go higher")
        case .rushing: return String(localized: "Rushing: hold back")
        case .dragging: return String(localized: "Dragging: move on")
        case .sectionClean: return String(localized: "Clean!")
        default: return e.text
        }
    }
}

extension WatchCoach: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let ctx = session.receivedApplicationContext
        Task { @MainActor in self.apply(context: ctx) }
    }
    nonisolated func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        guard let env = WatchEnvelope.decode(messageData) else { return }
        Task { @MainActor in self.handle(env) }
    }
    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in self.apply(context: applicationContext) }
    }
    private func apply(context: [String: Any]) {
        for key in ["session", "metronome"] {
            if let d = context[key] as? Data, let env = WatchEnvelope.decode(d) { handle(env) }
        }
    }
}

enum Haptics {
    static func play(_ name: String) {
        let t: WKHapticType
        switch name {
        case "failure": t = .failure
        case "retry": t = .retry
        case "directionUp": t = .directionUp
        case "directionDown": t = .directionDown
        case "success": t = .success
        case "start": t = .start
        case "stop": t = .stop
        case "notification": t = .notification
        default: t = .click
        }
        WKInterfaceDevice.current().play(t)
    }
}

/// Silent metronome on the wrist: the microphone hears only the player, and the beat is never late
/// because it is generated here, not streamed from the phone.
@MainActor
final class HapticMetronome: ObservableObject {
    @Published private(set) var running = false
    @Published var bpm = 80.0
    @Published private(set) var beat = 0
    var beatsPerBar = 4
    private var timer: DispatchSourceTimer?
    private var countIn = 0

    func start(bpm: Double, beatsPerBar: Int, at date: Date = Date(), countIn: Int = 0) {
        stop()
        self.bpm = bpm
        self.beatsPerBar = max(1, beatsPerBar)
        self.countIn = countIn
        beat = 0
        let t = DispatchSource.makeTimerSource(flags: .strict, queue: .main)
        t.schedule(deadline: .now() + max(0, date.timeIntervalSinceNow), repeating: 60.0 / max(20, bpm), leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.tick() }
        }
        t.resume()
        timer = t
        running = true
    }

    func stop() {
        timer?.cancel()
        timer = nil
        running = false
    }

    private func tick() {
        let downbeat = beat % beatsPerBar == 0
        if beat < countIn {
            WKInterfaceDevice.current().play(.click)
        } else {
            WKInterfaceDevice.current().play(downbeat ? .start : .click)
        }
        beat += 1
    }
}
