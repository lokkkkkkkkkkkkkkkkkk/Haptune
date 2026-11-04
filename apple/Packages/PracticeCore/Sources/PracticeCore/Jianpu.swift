import Foundation

/// Jianpu (简谱, numbered notation) text -> PracticeScore. Same format as engine/haptune/jianpu.py:
///
///     title: 茉莉花
///     key: 1=F
///     time: 2/4
///     tempo: 72
///     ---
///     3 3_5_ | 6_1'_1'_6_ | 5 - |
public enum Jianpu {
    static let major = [0, 2, 4, 5, 7, 9, 11]

    public static func parse(_ text: String, instrument: String = "") throws -> PracticeScore {
        var header: [String: String] = [:]
        var body: [String] = []
        var inBody = false
        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line == "---" { inBody = true; continue }
            if !inBody, let r = line.range(of: #"^([A-Za-z]+)\s*[:：]\s*(.+)$"#, options: .regularExpression) {
                let s = String(line[r])
                let sep = s.firstIndex(where: { $0 == ":" || $0 == "：" })!
                header[s[..<sep].trimmingCharacters(in: .whitespaces).lowercased()] =
                    s[s.index(after: sep)...].trimmingCharacters(in: .whitespaces)
            } else { inBody = true; body.append(line) }
        }
        let key = (header["key"] ?? "1=C").replacingOccurrences(of: " ", with: "")
        guard key.hasPrefix("1="), key.count >= 3 else { throw ScoreError.unreadable("bad key \(key)") }
        var k = String(key.dropFirst(2))
        var acc = 0
        if k.hasPrefix("#") { acc = 1; k.removeFirst() } else if k.hasPrefix("b") && k.count > 1 { acc = -1; k.removeFirst() }
        if k.hasSuffix("#") { acc = 1; k.removeLast() } else if k.count > 1 && k.hasSuffix("b") { acc = -1; k.removeLast() }
        guard let letter = k.uppercased().first, let base = MusicXMLParser.stepSemitone[String(letter)] else {
            throw ScoreError.unreadable("bad key \(key)")
        }
        let tonicPC = base + acc
        let octave = Int(header["octave"] ?? "4") ?? 4
        let tonic = 12 * (octave + 1) + tonicPC
        let ts = (header["time"] ?? "4/4").split(separator: "/").compactMap { Int($0) }
        let num = ts.count == 2 ? ts[0] : 4, den = ts.count == 2 ? ts[1] : 4
        let qpm = Double((header["tempo"] ?? "80").filter { "0123456789.".contains($0) }) ?? 80
        let barLen = Double(num * 4) / Double(den)

        // tokens: bar lines, repeat signs, dashes and notes (notes may be glued: "3_5_6_")
        let pattern = #"\|\||\|:|:\||\||-|[#b]?[0-7](?:'|\^|,|’|·)*_*\.?~?"#
        let joined = body.joined(separator: " ")
        let re = try NSRegularExpression(pattern: pattern)
        let tokens = re.matches(in: joined, range: NSRange(joined.startIndex..., in: joined)).compactMap {
            Range($0.range, in: joined).map { String(joined[$0]) }
        }
        struct Item { var on: Double; var dur: Double; var pitch: Int?; var tie: Bool }
        var bars: [[Item]] = [[]]
        var repeatStart: Set<Int> = [], repeatEnd: Set<Int> = []
        var t = 0.0
        for tok in tokens {
            switch tok {
            case "|", "||": bars.append([]); t = 0
            case "|:":
                if !(bars.last?.isEmpty ?? true) { bars.append([]); t = 0 }
                repeatStart.insert(bars.count - 1)
            case ":|": repeatEnd.insert(bars.count - 1); bars.append([]); t = 0
            case "-":
                if !bars[bars.count - 1].isEmpty { bars[bars.count - 1][bars[bars.count - 1].count - 1].dur += 1 }
                else if let pi = bars.indices.dropLast().last(where: { !bars[$0].isEmpty }) {
                    let p = bars[pi][bars[pi].count - 1].pitch
                    bars[pi][bars[pi].count - 1].tie = true
                    bars[bars.count - 1].append(Item(on: 0, dur: 1, pitch: p, tie: false))
                }
                t += 1
            default:
                var s = Substring(tok)
                var accd = 0
                if s.hasPrefix("#") { accd = 1; s = s.dropFirst() } else if s.hasPrefix("b") { accd = -1; s = s.dropFirst() }
                guard let d = s.first, let deg = Int(String(d)) else { continue }
                s = s.dropFirst()
                let ups = s.filter { "'^’·".contains($0) }.count, downs = s.filter { $0 == "," }.count
                let unders = s.filter { $0 == "_" }.count
                var dur = 1.0 / pow(2, Double(unders))
                if s.contains(".") { dur *= 1.5 }
                let pitch: Int? = deg == 0 ? nil : tonic + major[deg - 1] + accd + 12 * ups - 12 * downs
                bars[bars.count - 1].append(Item(on: t, dur: dur, pitch: pitch, tie: s.contains("~")))
                t += dur
            }
        }
        let filled = bars.enumerated().filter { !$0.element.isEmpty }
        var order: [Int] = []
        var start = 0, i = 0
        var repeated = Set<Int>()
        let src = filled.map { $0.offset }
        while i < src.count {
            if repeatStart.contains(src[i]) { start = i }
            order.append(i)
            if repeatEnd.contains(src[i]) && !repeated.contains(i) { repeated.insert(i); i = start; continue }
            i += 1
        }
        var notes: [PracticeScore.Note] = []
        var measures: [PracticeScore.Measure] = []
        var pos = 0.0, counter = 0
        var tieOpen: Int?
        let fifthsOf: [Int: Int] = [0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5]
        let fifths = fifthsOf[((tonicPC % 12) + 12) % 12] ?? 0
        for (mi, si) in order.enumerated() {
            let content = filled[si].element
            let len = content.map { $0.on + $0.dur }.max() ?? 0
            let length = (mi == 0 && len > 0 && len < barLen) ? len : max(barLen, len)
            measures.append(.init(index: mi, label: String(si + 1), start: pos, duration: length, timeSignature: [num, den],
                                  keyFifths: fifths, keyMode: "major", sourceIndex: si))
            for it in content {
                guard let p = it.pitch else { tieOpen = nil; continue }
                if let ti = tieOpen, notes[ti].pitch == p {
                    notes[ti].duration += it.dur
                    tieOpen = it.tie ? ti : nil
                    continue
                }
                counter += 1
                notes.append(.init(id: "J-\(mi)-\(counter)", part: "J", measure: mi, onset: pos + it.on, duration: it.dur,
                                   pitch: p, written: p, sourceIndex: counter))
                tieOpen = it.tie ? notes.count - 1 : nil
            }
            pos += length
        }
        let inst = header["instrument"] ?? instrument
        return PracticeScore(title: header["title"] ?? "", composer: header["composer"] ?? "",
                             parts: [.init(id: "J", name: inst.isEmpty ? "Melody" : inst, instrument: inst)],
                             measures: measures, tempos: [[0, qpm]], notes: notes,
                             source: .object(["format": .string("jianpu"), "key": .string(key)]))
    }
}
