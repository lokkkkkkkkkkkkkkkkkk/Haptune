import Foundation

/// One decision of the follower, sent from the phone to the Watch (see engine/haptune/haptics.py).
public struct FeedbackEvent: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable, CaseIterable {
        case wrongNote = "wrong_note", missedNote = "missed_note", sharp, flat, rushing, dragging
        case sectionClean = "section_clean", countIn = "count_in", beat, downbeat, pageTurn = "page_turn", jump
    }

    public var id = UUID()
    public var kind: Kind
    public var time: Double                 // seconds since the take started
    public var measure: Int?
    public var measureLabel: String?
    public var noteID: String?
    public var expected: Int?
    public var played: Int?
    public var cents: Double?
    public var text: String

    enum CodingKeys: String, CodingKey {
        case kind = "type", time, measure, measureLabel = "measure_label", noteID = "note_id", expected, played, cents, text
    }

    public init(_ kind: Kind, time: Double, measure: Int? = nil, noteID: String? = nil, expected: Int? = nil,
                played: Int? = nil, cents: Double? = nil, text: String = "") {
        self.kind = kind; self.time = time; self.measure = measure; self.noteID = noteID
        self.expected = expected; self.played = played; self.cents = cents; self.text = text
    }

    public var spec: HapticSpec { HapticSpec.table[kind] ?? HapticSpec.fallback }
    public var isCorrective: Bool { [.wrongNote, .missedNote, .sharp, .flat, .rushing, .dragging].contains(kind) }
}

/// What the wrist feels and shows for each event kind.
public struct HapticSpec: Codable, Sendable {
    public let event: String
    public let watchHaptic: String          // WKHapticType case name
    public let glyph: String                // SF Symbol
    public let priority: Int
    public let cooldownMs: Int
    public let description: String
    enum CodingKeys: String, CodingKey {
        case event, glyph, priority, description
        case watchHaptic = "watch_haptic", cooldownMs = "cooldown_ms"
    }

    static let fallback = HapticSpec(event: "other", watchHaptic: "click", glyph: "circle", priority: 0, cooldownMs: 0, description: "")

    private struct File: Codable { let events: [HapticSpec] }

    public static let table: [FeedbackEvent.Kind: HapticSpec] = {
        var out: [FeedbackEvent.Kind: HapticSpec] = [:]
        if let url = Bundle.module.url(forResource: "haptics", withExtension: "json"),
           let data = try? Data(contentsOf: url), let f = try? JSONDecoder().decode(File.self, from: data) {
            for s in f.events { if let k = FeedbackEvent.Kind(rawValue: s.event) { out[k] = s } }
        }
        return out
    }()
}

/// Cooldown + priority filter so the wrist is never spammed (same rules as the Python HapticGate).
public struct HapticGate: Sendable {
    public enum Sensitivity: String, Codable, Sendable, CaseIterable { case gentle, normal, strict }
    private var last: [FeedbackEvent.Kind: Double] = [:]
    private var lastAny = -1e9
    private let scale: Double

    public init(sensitivity: Sensitivity = .normal) {
        scale = ["gentle": 1.6, "normal": 1.0, "strict": 0.7][sensitivity.rawValue] ?? 1
    }

    public mutating func allow(_ ev: FeedbackEvent) -> Bool {
        let spec = ev.spec
        if spec.cooldownMs == 0 { return true }
        let cd = Double(spec.cooldownMs) * scale / 1000
        if ev.time - (last[ev.kind] ?? -1e9) < cd { return false }
        if spec.priority < 5 && ev.time - lastAny < 0.35 { return false }
        last[ev.kind] = ev.time
        lastAny = ev.time
        return true
    }
}
