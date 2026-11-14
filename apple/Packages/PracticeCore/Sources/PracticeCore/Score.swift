import Foundation

/// The canonical practice score ("haptune.score/1"), identical to the Python engine's JSON.
/// Every note is at SOUNDING pitch, onsets/durations in quarter-note beats, repeats unrolled,
/// ties merged. The phone, the Watch and the server all agree on these ids and bar numbers.
public struct PracticeScore: Codable, Equatable, Sendable {
    public static let schemaName = "haptune.score/1"

    public var schema: String = PracticeScore.schemaName
    public var title: String
    public var composer: String
    public var parts: [Part]
    public var measures: [Measure]
    public var tempos: [[Double]]          // [[beat, quarter-notes per minute], ...]
    public var notes: [Note]
    public var source: JSONValue?

    enum CodingKeys: String, CodingKey { case schema, title, composer, parts, measures, tempos, notes, source }

    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        schema = try c.decodeIfPresent(String.self, forKey: .schema) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        composer = try c.decodeIfPresent(String.self, forKey: .composer) ?? ""
        parts = try c.decodeIfPresent([Part].self, forKey: .parts) ?? []
        measures = try c.decodeIfPresent([Measure].self, forKey: .measures) ?? []
        tempos = try c.decodeIfPresent([[Double]].self, forKey: .tempos) ?? [[0, 100]]
        notes = try c.decodeIfPresent([Note].self, forKey: .notes) ?? []
        source = try c.decodeIfPresent(JSONValue.self, forKey: .source)
    }

    public init(title: String = "", composer: String = "", parts: [Part] = [], measures: [Measure] = [],
                tempos: [[Double]] = [[0, 100]], notes: [Note] = [], source: JSONValue? = nil) {
        self.title = title; self.composer = composer; self.parts = parts; self.measures = measures
        self.tempos = tempos; self.notes = notes; self.source = source
    }

    public struct Part: Codable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var instrument: String
        public var transpose: Int
        public var midiProgram: Int?
        enum CodingKeys: String, CodingKey { case id, name, instrument, transpose; case midiProgram = "midi_program" }
        public init(id: String, name: String = "", instrument: String = "", transpose: Int = 0, midiProgram: Int? = nil) {
            self.id = id; self.name = name; self.instrument = instrument; self.transpose = transpose; self.midiProgram = midiProgram
        }
        public init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
            instrument = try c.decodeIfPresent(String.self, forKey: .instrument) ?? ""
            transpose = try c.decodeIfPresent(Int.self, forKey: .transpose) ?? 0
            midiProgram = try c.decodeIfPresent(Int.self, forKey: .midiProgram)
        }
    }

    public struct Measure: Codable, Equatable, Sendable {
        public var index: Int
        public var label: String
        public var start: Double
        public var duration: Double
        public var timeSignature: [Int]
        public var keyFifths: Int
        public var keyMode: String
        public var sourceIndex: Int
        enum CodingKeys: String, CodingKey { case i, label, start, dur, time, key, src }
        public init(index: Int, label: String, start: Double, duration: Double, timeSignature: [Int] = [4, 4],
                    keyFifths: Int = 0, keyMode: String = "major", sourceIndex: Int? = nil) {
            self.index = index; self.label = label; self.start = start; self.duration = duration
            self.timeSignature = timeSignature; self.keyFifths = keyFifths; self.keyMode = keyMode
            self.sourceIndex = sourceIndex ?? index
        }
        public init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            index = try c.decode(Int.self, forKey: .i)
            label = try c.decode(String.self, forKey: .label)
            start = try c.decode(Double.self, forKey: .start)
            duration = try c.decode(Double.self, forKey: .dur)
            timeSignature = try c.decodeIfPresent([Int].self, forKey: .time) ?? [4, 4]
            if var k = try? c.nestedUnkeyedContainer(forKey: .key) {
                keyFifths = (try? k.decode(Int.self)) ?? 0
                keyMode = (try? k.decode(String.self)) ?? "major"
            } else { keyFifths = 0; keyMode = "major" }
            sourceIndex = try c.decodeIfPresent(Int.self, forKey: .src) ?? index
        }
        public func encode(to e: Encoder) throws {
            var c = e.container(keyedBy: CodingKeys.self)
            try c.encode(index, forKey: .i); try c.encode(label, forKey: .label)
            try c.encode(start, forKey: .start); try c.encode(duration, forKey: .dur)
            try c.encode(timeSignature, forKey: .time)
            var k = c.nestedUnkeyedContainer(forKey: .key)
            try k.encode(keyFifths); try k.encode(keyMode)
            try c.encode(sourceIndex, forKey: .src)
        }
    }

    public struct Note: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var part: String
        public var measure: Int
        public var onset: Double
        public var duration: Double
        public var pitch: Int?          // sounding MIDI pitch, nil = unpitched
        public var written: Int?
        public var voice: String
        public var staff: Int
        public var grace: Bool
        public var sourceIndex: Int
        enum CodingKeys: String, CodingKey { case id, part, m, on, dur, p, w, v, st, g, src }
        public init(id: String, part: String, measure: Int, onset: Double, duration: Double, pitch: Int?,
                    written: Int? = nil, voice: String = "1", staff: Int = 1, grace: Bool = false, sourceIndex: Int = 0) {
            self.id = id; self.part = part; self.measure = measure; self.onset = onset; self.duration = duration
            self.pitch = pitch; self.written = written ?? pitch; self.voice = voice; self.staff = staff
            self.grace = grace; self.sourceIndex = sourceIndex
        }
        public init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            part = try c.decode(String.self, forKey: .part)
            measure = try c.decode(Int.self, forKey: .m)
            onset = try c.decode(Double.self, forKey: .on)
            duration = try c.decode(Double.self, forKey: .dur)
            pitch = try c.decodeIfPresent(Int.self, forKey: .p)
            written = try c.decodeIfPresent(Int.self, forKey: .w)
            if let s = try? c.decodeIfPresent(String.self, forKey: .v) { voice = s }
            else if let n = try? c.decodeIfPresent(Int.self, forKey: .v) { voice = String(n) } else { voice = "1" }
            staff = try c.decodeIfPresent(Int.self, forKey: .st) ?? 1
            grace = try c.decodeIfPresent(Bool.self, forKey: .g) ?? false
            sourceIndex = try c.decodeIfPresent(Int.self, forKey: .src) ?? 0
        }
        public func encode(to e: Encoder) throws {
            var c = e.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id); try c.encode(part, forKey: .part); try c.encode(measure, forKey: .m)
            try c.encode(onset, forKey: .on); try c.encode(duration, forKey: .dur)
            try c.encode(pitch, forKey: .p); try c.encode(written, forKey: .w); try c.encode(voice, forKey: .v)
            try c.encode(staff, forKey: .st); try c.encode(grace, forKey: .g); try c.encode(sourceIndex, forKey: .src)
        }
    }

    /// Notes that start together (one chord or one single note).
    public struct Event: Equatable, Sendable {
        public var index: Int
        public var onset: Double
        public var notes: [Note]
        public var pitches: [Int] { Array(Set(notes.compactMap { $0.pitch })).sorted() }
        public var measure: Int { notes.first?.measure ?? 0 }
    }

    // MARK: timing

    private var tempoSegments: [(beat: Double, sec: Double, qpm: Double)] {
        var t: [(beat: Double, qpm: Double)] = tempos.compactMap { (x: [Double]) -> (beat: Double, qpm: Double)? in
            x.count >= 2 && x[1] > 0 ? (beat: x[0], qpm: x[1]) : nil
        }
        t.sort { $0.beat < $1.beat }
        if t.isEmpty { t = [(beat: 0, qpm: 100)] }
        if t[0].beat > 0 { t.insert((beat: 0, qpm: t[0].qpm), at: 0) }
        var segs: [(Double, Double, Double)] = []
        var sec = 0.0
        for (i, x) in t.enumerated() {
            segs.append((x.beat, sec, x.qpm))
            if i + 1 < t.count { sec += (t[i + 1].beat - x.beat) * 60 / x.qpm }
        }
        return segs.map { (beat: $0.0, sec: $0.1, qpm: $0.2) }
    }

    public func beatToSeconds(_ beat: Double) -> Double {
        let segs = tempoSegments
        let s = segs.last(where: { $0.beat <= beat }) ?? segs[0]
        return s.sec + (beat - s.beat) * 60 / s.qpm
    }

    public func secondsToBeat(_ sec: Double) -> Double {
        let segs = tempoSegments
        let s = segs.last(where: { $0.sec <= sec }) ?? segs[0]
        return s.beat + (sec - s.sec) * s.qpm / 60
    }

    public var firstTempo: Double { tempos.sorted { ($0.first ?? 0) < ($1.first ?? 0) }.first.flatMap { $0.count > 1 ? $0[1] : nil } ?? 100 }

    public var lengthBeats: Double {
        if let m = measures.last { return m.start + m.duration }
        return notes.map { $0.onset + $0.duration }.max() ?? 0
    }

    public func measureIndex(atBeat beat: Double) -> Int {
        var idx = 0
        for (i, m) in measures.enumerated() where m.start <= beat + 1e-9 { idx = i }
        return idx
    }

    public func measureLabel(_ index: Int) -> String {
        index >= 0 && index < measures.count ? measures[index].label : String(index + 1)
    }

    // MARK: selection

    public func playableNotes() -> [Note] {
        notes.filter { !$0.grace }.sorted { ($0.onset, $0.pitch ?? 0) < ($1.onset, $1.pitch ?? 0) }
    }

    public func events(tolerance: Double = 1e-4) -> [Event] {
        var out: [Event] = []
        for n in playableNotes() {
            if let last = out.last, abs(n.onset - last.onset) <= tolerance {
                out[out.count - 1].notes.append(n)
            } else {
                out.append(Event(index: out.count, onset: n.onset, notes: [n]))
            }
        }
        return out
    }

    public func selectingParts(_ ids: Set<String>) -> PracticeScore {
        var s = self
        s.notes = notes.filter { ids.contains($0.part) }
        s.parts = parts.filter { ids.contains($0.id) }
        return s
    }

    /// Measures first...last (0-based), re-based so the slice starts at beat 0 (practice loops).
    public func slice(measures first: Int, _ last: Int) -> PracticeScore {
        guard first >= 0, last < measures.count, first <= last else { return self }
        let ms = Array(measures[first...last])
        let b0 = ms[0].start
        let b1 = ms[ms.count - 1].start + ms[ms.count - 1].duration
        var s = self
        s.notes = notes.filter { $0.onset >= b0 - 1e-9 && $0.onset < b1 - 1e-9 }.map {
            var n = $0; n.onset -= b0; n.measure -= first; return n
        }
        s.measures = ms.map { var m = $0; m.index -= first; m.start -= b0; return m }
        var t: [[Double]] = []
        for tp in tempos.sorted(by: { $0[0] < $1[0] }) where tp.count >= 2 {
            if tp[0] <= b0 { t = [[0, tp[1]]] } else if tp[0] < b1 { t.append([tp[0] - b0, tp[1]]) }
        }
        s.tempos = t.isEmpty ? [[0, firstTempo]] : t
        return s
    }

    // MARK: JSON

    public static func decode(_ data: Data) throws -> PracticeScore {
        let s = try JSONDecoder().decode(PracticeScore.self, from: data)
        guard s.schema == schemaName else { throw ScoreError.badSchema(s.schema) }
        return s
    }

    public func encoded() throws -> Data {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return try e.encode(self)
    }
}

public enum ScoreError: Error, LocalizedError {
    case badSchema(String), unreadable(String), unsupported(String)
    public var errorDescription: String? {
        switch self {
        case .badSchema(let s): return "Not a Melovyn score (\(s))"
        case .unreadable(let s): return "Could not read the score: \(s)"
        case .unsupported(let s): return "Unsupported file: \(s)"
        }
    }
}

/// Minimal JSON value so unknown/free-form fields survive a round trip.
public enum JSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    public init(from d: Decoder) throws {
        let c = try d.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to e: Encoder) throws {
        var c = e.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
}

public enum NoteName {
    static let sharps = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]
    static let flats = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"]
    public static func name(_ midi: Int?, preferFlats: Bool = false) -> String {
        guard let m = midi else { return "–" }
        let names = preferFlats ? flats : sharps
        return "\(names[((m % 12) + 12) % 12])\(m / 12 - 1)"
    }
}
