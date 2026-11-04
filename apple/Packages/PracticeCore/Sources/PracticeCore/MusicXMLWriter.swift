import Foundation

/// PracticeScore -> MusicXML, so scores that arrive as jianpu text or generated exercises can be
/// engraved by Verovio on the device. Simple but correct notation: one staff per part, chords,
/// rests filling gaps, ties across bar lines, dotted values and triplets.
public enum MusicXMLWriter {
    static let divisions = 48
    // (divisions, type, dots, tuplet)
    static let values: [(Int, String, Int, Bool)] = [
        (192, "whole", 0, false), (144, "half", 1, false), (96, "half", 0, false), (72, "quarter", 1, false),
        (48, "quarter", 0, false), (36, "eighth", 1, false), (32, "quarter", 0, true), (24, "eighth", 0, false),
        (18, "16th", 1, false), (16, "eighth", 0, true), (12, "16th", 0, false), (8, "16th", 0, true),
        (6, "32nd", 0, false), (3, "64th", 0, false),
    ]

    struct Piece { var divs: Int; var type: String; var dots: Int; var triplet: Bool }

    static func pieces(_ divs: Int) -> [Piece] {
        var left = divs, out: [Piece] = []
        while left > 0 {
            guard let v = values.first(where: { $0.0 <= left }) else { break }
            out.append(Piece(divs: v.0, type: v.1, dots: v.2, triplet: v.3))
            left -= v.0
        }
        return out
    }

    static func spell(_ midi: Int, fifths: Int) -> (step: String, alter: Int, octave: Int) {
        let sharp: [(String, Int)] = [("C", 0), ("C", 1), ("D", 0), ("D", 1), ("E", 0), ("F", 0), ("F", 1), ("G", 0), ("G", 1), ("A", 0), ("A", 1), ("B", 0)]
        let flat: [(String, Int)] = [("C", 0), ("D", -1), ("D", 0), ("E", -1), ("E", 0), ("F", 0), ("G", -1), ("G", 0), ("A", -1), ("A", 0), ("B", -1), ("B", 0)]
        let pc = ((midi % 12) + 12) % 12
        let (s, a) = (fifths < 0 ? flat : sharp)[pc]
        return (s, a, midi / 12 - 1)
    }

    public static func write(_ score: PracticeScore) -> String {
        var x = """
        <?xml version="1.0" encoding="UTF-8"?>
        <score-partwise version="3.1">
        <work><work-title>\(esc(score.title))</work-title></work>
        <identification><creator type="composer">\(esc(score.composer))</creator></identification>
        <part-list>
        """
        let parts = score.parts.isEmpty ? [PracticeScore.Part(id: "P1", name: "Music")] : score.parts
        for p in parts { x += "<score-part id=\"\(esc(p.id))\"><part-name>\(esc(p.name.isEmpty ? p.instrument : p.name))</part-name></score-part>\n" }
        x += "</part-list>\n"
        for p in parts { x += writePart(score, part: p) }
        x += "</score-partwise>\n"
        return x
    }

    static func writePart(_ score: PracticeScore, part: PracticeScore.Part) -> String {
        let pn = score.notes.filter { $0.part == part.id && !$0.grace }
        let ws = pn.compactMap { $0.written ?? $0.pitch }
        let median = ws.sorted().dropFirst(ws.count / 2).first ?? 67
        let bass = median < 57
        var x = "<part id=\"\(esc(part.id))\">\n"
        let q = Double(divisions)
        // split notes at bar lines (ties), keyed by measure
        struct Seg { var on: Int; var len: Int; var pitch: Int?; var tieStart: Bool; var tieStop: Bool }
        var perMeasure = [[Seg]](repeating: [], count: score.measures.count)
        for n in pn {
            var on = n.onset, rest = n.duration, first = true
            while rest > 1e-6 {
                let mi = score.measureIndex(atBeat: on)
                guard mi < score.measures.count else { break }
                let m = score.measures[mi]
                let room = m.start + m.duration - on
                let take = min(rest, max(room, 1.0 / q))
                rest -= take
                perMeasure[mi].append(Seg(on: Int(((on - m.start) * q).rounded()), len: max(1, Int((take * q).rounded())),
                                          pitch: n.written ?? n.pitch, tieStart: rest > 1e-6, tieStop: !first))
                on += take; first = false
            }
        }
        var lastTime: [Int] = [], lastKey = Int.min
        for (mi, m) in score.measures.enumerated() {
            x += "<measure number=\"\(esc(m.label))\">\n"
            if mi == 0 || m.timeSignature != lastTime || m.keyFifths != lastKey {
                x += "<attributes>"
                if mi == 0 { x += "<divisions>\(divisions)</divisions>" }
                x += "<key><fifths>\(m.keyFifths)</fifths><mode>\(m.keyMode)</mode></key>"
                x += "<time><beats>\(m.timeSignature.first ?? 4)</beats><beat-type>\(m.timeSignature.last ?? 4)</beat-type></time>"
                if mi == 0 {
                    x += bass ? "<clef><sign>F</sign><line>4</line></clef>" : "<clef><sign>G</sign><line>2</line></clef>"
                    if part.transpose != 0 {
                        let oct = part.transpose / 12, chrom = part.transpose - 12 * oct
                        x += "<transpose><chromatic>\(chrom)</chromatic>\(oct != 0 ? "<octave-change>\(oct)</octave-change>" : "")</transpose>"
                    }
                }
                x += "</attributes>\n"
                lastTime = m.timeSignature; lastKey = m.keyFifths
            }
            if mi == 0 {
                let bpm = Int(score.firstTempo.rounded())
                x += "<direction placement=\"above\"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>\(bpm)</per-minute></metronome></direction-type><sound tempo=\"\(bpm)\"/></direction>\n"
            }
            // group by onset -> chords; a chord lasts until the next onset at most
            let groups = Dictionary(grouping: perMeasure[mi], by: { $0.on })
            let onsets = groups.keys.sorted()
            let total = Int((m.duration * q).rounded())
            var cursor = 0
            for (k, on) in onsets.enumerated() {
                if on > cursor {
                    x += rests(on - cursor)
                    cursor = on
                }
                if on < cursor { continue }                         // overlapping voice: drop for display
                let segs = groups[on]!
                let next = k + 1 < onsets.count ? onsets[k + 1] : total
                let len = max(1, min(segs.map { $0.len }.max() ?? 1, next - on, total - on))
                let pcs = pieces(len)
                for (pi, piece) in pcs.enumerated() {
                    for (ci, s) in segs.sorted(by: { ($0.pitch ?? 0) < ($1.pitch ?? 0) }).enumerated() {
                        let tieStop = pi > 0 || s.tieStop
                        let tieStart = pi < pcs.count - 1 || s.tieStart
                        x += note(s.pitch, piece: piece, chord: ci > 0, tieStart: tieStart, tieStop: tieStop, fifths: m.keyFifths)
                    }
                }
                cursor = on + len
            }
            if cursor < total { x += rests(total - cursor) }
            if mi == score.measures.count - 1 { x += "<barline location=\"right\"><bar-style>light-heavy</bar-style></barline>\n" }
            x += "</measure>\n"
        }
        return x + "</part>\n"
    }

    static func rests(_ divs: Int) -> String {
        pieces(divs).map { p in
            "<note><rest/><duration>\(p.divs)</duration><type>\(p.type)</type>\(String(repeating: "<dot/>", count: p.dots))\(p.triplet ? "<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>" : "")</note>\n"
        }.joined()
    }

    static func note(_ midi: Int?, piece: Piece, chord: Bool, tieStart: Bool, tieStop: Bool, fifths: Int) -> String {
        var s = "<note>"
        if chord { s += "<chord/>" }
        if let m = midi {
            let sp = spell(m, fifths: fifths)
            s += "<pitch><step>\(sp.step)</step>\(sp.alter != 0 ? "<alter>\(sp.alter)</alter>" : "")<octave>\(sp.octave)</octave></pitch>"
        } else {
            s += "<unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched>"
        }
        s += "<duration>\(piece.divs)</duration>"
        if tieStop { s += "<tie type=\"stop\"/>" }
        if tieStart { s += "<tie type=\"start\"/>" }
        s += "<type>\(piece.type)</type>" + String(repeating: "<dot/>", count: piece.dots)
        if piece.triplet { s += "<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>" }
        if tieStart || tieStop {
            s += "<notations>\(tieStop ? "<tied type=\"stop\"/>" : "")\(tieStart ? "<tied type=\"start\"/>" : "")</notations>"
        }
        return s + "</note>\n"
    }

    static func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }
}

/// Scales and arpeggios (port of engine/haptune/exercises.py).
public enum Exercises {
    public static let patterns: [String: [Int]] = [
        "major": [0, 2, 4, 5, 7, 9, 11], "natural_minor": [0, 2, 3, 5, 7, 8, 10],
        "harmonic_minor": [0, 2, 3, 5, 7, 8, 11], "melodic_minor": [0, 2, 3, 5, 7, 9, 11],
        "major_pentatonic": [0, 2, 4, 7, 9], "minor_pentatonic": [0, 3, 5, 7, 10], "blues": [0, 3, 5, 6, 7, 10],
        "chromatic": Array(0..<12), "major_arpeggio": [0, 4, 7], "minor_arpeggio": [0, 3, 7],
        "dominant7_arpeggio": [0, 4, 7, 10], "diminished7_arpeggio": [0, 3, 6, 9],
    ]
    public static let tonics = ["C": 0, "C#": 1, "Db": 1, "D": 2, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6,
                                "G": 7, "Ab": 8, "A": 9, "Bb": 10, "B": 11]
    static let fifthsOf: [Int: Int] = [0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5]

    public static func scale(tonic: String, kind: String, octaves: Int, instrument: InstrumentProfile,
                             qpm: Double = 80, notesPerBeat: Int = 2) -> PracticeScore {
        let pc = tonics[tonic] ?? 0
        let pat = patterns[kind] ?? patterns["major"]!
        var base = (instrument.low...instrument.high).first(where: { $0 % 12 == pc }) ?? 60
        while base + 12 * octaves > instrument.high && base - 12 >= instrument.low { base -= 12 }
        var up: [Int] = []
        for o in 0..<octaves { for iv in pat { up.append(base + 12 * o + iv) } }
        up.append(base + 12 * octaves)
        var down: [Int]
        if kind == "melodic_minor" {
            down = []
            for o in 0..<octaves { for iv in patterns["natural_minor"]! { down.append(base + 12 * o + iv) } }
            down.reverse()
        } else { down = Array(up.dropLast().reversed()) }
        let seq = up + down
        let d = 1.0 / Double(notesPerBeat)
        var notes: [PracticeScore.Note] = []
        for (i, p) in seq.enumerated() {
            let dur = i == seq.count - 1 ? max(1, d) : d
            notes.append(.init(id: "S-\(i)", part: "P1", measure: Int(Double(i) * d / 4), onset: Double(i) * d, duration: dur,
                               pitch: p, written: p - instrument.transpose, sourceIndex: i + 1))
        }
        let end = (notes.last.map { $0.onset + $0.duration } ?? 4)
        let bars = Int(ceil(end / 4))
        let isMinor = kind.contains("minor")
        let fifths = fifthsOf[isMinor ? (pc + 3) % 12 : pc] ?? 0
        let measures = (0..<bars).map { PracticeScore.Measure(index: $0, label: String($0 + 1), start: Double($0 * 4),
                                                               duration: 4, keyFifths: fifths, keyMode: isMinor ? "minor" : "major") }
        return PracticeScore(title: "\(tonic) \(kind.replacingOccurrences(of: "_", with: " ")) (\(octaves) octave\(octaves > 1 ? "s" : ""))",
                             parts: [.init(id: "P1", name: instrument.name, instrument: instrument.key, transpose: instrument.transpose)],
                             measures: measures, tempos: [[0, qpm]], notes: notes,
                             source: .object(["format": .string("exercise")]))
    }
}
