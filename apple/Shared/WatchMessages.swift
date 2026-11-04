import Foundation
import PracticeCore

/// Everything the iPhone and the Watch say to each other, as one Codable envelope
/// (sent with WCSession.sendMessageData for low latency).
struct WatchEnvelope: Codable {
    enum Kind: String, Codable { case feedback, session, position, metronome, command, summary }

    var kind: Kind
    var feedback: FeedbackEvent?
    var session: SessionInfo?
    var position: Position?
    var metronome: MetronomeConfig?
    var command: Command?
    var summary: Summary?

    struct SessionInfo: Codable {
        var title: String
        var instrument: String
        var mode: String
        var running: Bool
    }

    struct Position: Codable {
        var measureLabel: String
        var expectedNote: String
    }

    /// The metronome runs ON the Watch (silent for the microphone, never late).
    /// `startAt` is wall-clock time (both devices are NTP-synced to within a few ms).
    struct MetronomeConfig: Codable {
        var enabled: Bool
        var bpm: Double
        var beatsPerBar: Int
        var startAt: Date
        var countInBeats: Int
    }

    enum Command: String, Codable { case start, stop, restartLoop, toggleMetronome, nextMode }

    struct Summary: Codable {
        var correct: Int
        var wrong: Int
        var missed: Int
        var total: Int
    }

    static func feedback(_ e: FeedbackEvent) -> WatchEnvelope { WatchEnvelope(kind: .feedback, feedback: e) }
    static func command(_ c: Command) -> WatchEnvelope { WatchEnvelope(kind: .command, command: c) }

    func encoded() -> Data? { try? JSONEncoder().encode(self) }
    static func decode(_ data: Data) -> WatchEnvelope? { try? JSONDecoder().decode(WatchEnvelope.self, from: data) }
}
