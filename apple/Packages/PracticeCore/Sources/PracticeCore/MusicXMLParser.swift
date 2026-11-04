import Foundation
#if canImport(FoundationXML)
import FoundationXML
#endif
import ZIPFoundation

/// MusicXML (.musicxml / .xml / .mxl) -> PracticeScore.
/// Port of `engine/haptune/score.py` (validated there against music21 on 300 corpus files):
/// chords, voices, backup/forward, ties, transposing instruments, tempo marks, key/time changes,
/// repeat barlines, 1st/2nd endings, D.C. / D.S. al Fine / al Coda.
public enum MusicXMLParser {

    public static func load(url: URL, expandRepeats: Bool = true) throws -> PracticeScore {
        let data = try Data(contentsOf: url)
        return try parse(data: data, expandRepeats: expandRepeats, fallbackTitle: url.deletingPathExtension().lastPathComponent)
    }

    public static func parse(data: Data, expandRepeats: Bool = true, fallbackTitle: String = "") throws -> PracticeScore {
        let xmlData = try unzipIfNeeded(data)
        guard let root = XMLTree.parse(xmlData) else { throw ScoreError.unreadable("invalid XML") }
        guard root.name == "score-partwise" else {
            throw ScoreError.unsupported("only score-partwise MusicXML is supported on the device (got \(root.name)); use the server import")
        }
        return try build(root: root, expandRepeats: expandRepeats, fallbackTitle: fallbackTitle)
    }

    // MARK: - .mxl

    public static func unzipIfNeeded(_ data: Data) throws -> Data {
        guard data.count > 4, data[data.startIndex] == 0x50, data[data.startIndex + 1] == 0x4B else { return data }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mxl")
        try data.write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let archive = try Archive(url: tmp, accessMode: .read)
        func read(_ path: String) throws -> Data? {
            guard let entry = archive[path] else { return nil }
            var out = Data()
            _ = try archive.extract(entry) { out.append($0) }
            return out
        }
        var rootPath: String?
        if let container = try read("META-INF/container.xml"), let c = XMLTree.parse(container) {
            rootPath = c.first("rootfiles")?.first("rootfile")?.attributes["full-path"]
                ?? c.descendants("rootfile").first?.attributes["full-path"]
        }
        if rootPath == nil {
            rootPath = archive.first(where: {
                let p = $0.path.lowercased()
                return (p.hasSuffix(".xml") || p.hasSuffix(".musicxml")) && !p.hasPrefix("meta-inf")
            })?.path
        }
        guard let rp = rootPath, let xml = try read(rp) else { throw ScoreError.unreadable("no score inside the .mxl") }
        return xml
    }

    // MARK: - parsing

    static let stepSemitone: [String: Int] = ["C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11]
    static let grid = 96.0
    static func snap(_ x: Double) -> Double { (x * grid).rounded() / grid }

    struct SrcNote {
        var onset: Double, duration: Double, pitch: Int?, written: Int?, voice: String, staff: Int
        var grace: Bool, tieStart: Bool, tieStop: Bool, srcIndex: Int
    }

    struct SrcMeasure {
        var number: String
        var length: Double
        var notes: [SrcNote] = []
        var tempos: [(Double, Double)] = []
        var timeSig: [Int] = [4, 4]
        var key: (Int, String) = (0, "major")
        var forward = false
        var backwardTimes = 0
        var endingNumbers: Set<Int>? = nil
        var endingStart = false
        var endingStop = false
        var jumps: [String: String] = [:]
    }

    static func endingNumbers(_ s: String?) -> Set<Int> {
        let nums = (s ?? "").split(whereSeparator: { $0 == "," || $0 == " " }).compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        return nums.isEmpty ? [1] : Set(nums)
    }

    static func parsePart(_ part: XMLTree.Node, counter: inout Int) -> [SrcMeasure] {
        var divisions = 1.0
        var timeSig = [4, 4]
        var key: (Int, String) = (0, "major")
        var transpose = 0
        var out: [SrcMeasure] = []
        for m in part.children where m.name == "measure" {
            var t = 0.0, maxT = 0.0, lastOnset = 0.0
            var sm = SrcMeasure(number: m.attributes["number"] ?? String(out.count + 1), length: 0)
            for el in m.children {
                switch el.name {
                case "attributes":
                    if let d = el.text("divisions"), let v = Double(d), v > 0 { divisions = v }
                    if let k = el.first("key"), let f = k.text("fifths"), let fi = Int(f) { key = (fi, k.text("mode") ?? "major") }
                    if let ts = el.first("time"), let b = ts.text("beats") {
                        let beats = b.split(separator: "+").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }.reduce(0, +)
                        timeSig = [beats > 0 ? beats : 4, Int(ts.text("beat-type") ?? "4") ?? 4]
                    }
                    if let tr = el.first("transpose") {
                        transpose = Int(Double(tr.text("chromatic") ?? "0") ?? 0) + 12 * (Int(tr.text("octave-change") ?? "0") ?? 0)
                    }
                case "backup":
                    t = max(0, t - (Double(el.text("duration") ?? "0") ?? 0) / divisions)
                case "forward":
                    t += (Double(el.text("duration") ?? "0") ?? 0) / divisions
                    maxT = max(maxT, t)
                case "direction", "sound":
                    let snd = el.name == "sound" ? el : el.first("sound")
                    let offset = el.name == "direction" ? (Double(el.text("offset") ?? "0") ?? 0) / divisions : 0
                    var qpm: Double? = snd.flatMap { $0.attributes["tempo"] }.flatMap { Double($0) }
                    if qpm == nil, el.name == "direction", let mt = el.descendants("metronome").first,
                       let pm = mt.text("per-minute"), let v = Double(pm.filter { "0123456789.".contains($0) }) {
                        var unit: Double = ["whole": 4, "half": 2, "quarter": 1, "eighth": 0.5, "16th": 0.25][mt.text("beat-unit") ?? "quarter"] ?? 1
                        if mt.first("beat-unit-dot") != nil { unit *= 1.5 }
                        qpm = v * unit
                    }
                    if let q = qpm, q > 0 { sm.tempos.append((t + offset, q)) }
                case "barline":
                    if let rep = el.first("repeat") {
                        if rep.attributes["direction"] == "forward" { sm.forward = true }
                        if rep.attributes["direction"] == "backward" { sm.backwardTimes = Int(rep.attributes["times"] ?? "2") ?? 2 }
                    }
                    if let end = el.first("ending") {
                        let typ = end.attributes["type"] ?? "start"
                        if typ == "start" { sm.endingStart = true; sm.endingNumbers = endingNumbers(end.attributes["number"]) }
                        else if typ == "stop" || typ == "discontinue" {
                            sm.endingStop = true
                            if sm.endingNumbers == nil { sm.endingNumbers = endingNumbers(end.attributes["number"]) }
                        }
                    }
                case "note":
                    let isChord = el.first("chord") != nil
                    let isGrace = el.first("grace") != nil
                    let isCue = el.first("cue") != nil
                    let dur = (Double(el.text("duration") ?? "0") ?? 0) / divisions
                    let onset = isChord ? lastOnset : t
                    var pitch: Int? = nil, written: Int? = nil
                    if let p = el.first("pitch"), let step = p.text("step"), let semis = stepSemitone[step] {
                        let alter = Int((Double(p.text("alter") ?? "0") ?? 0).rounded())
                        let w = 12 * ((Int(p.text("octave") ?? "4") ?? 4) + 1) + semis + alter
                        written = w; pitch = w + transpose
                    }
                    let isRest = el.first("rest") != nil
                    let unpitched = el.first("unpitched") != nil
                    var ties = Set(el.children.filter { $0.name == "tie" }.compactMap { $0.attributes["type"] })
                    ties.formUnion(el.descendants("tied").compactMap { $0.attributes["type"] })
                    if !isRest && !isCue && (pitch != nil || unpitched) {
                        counter += 1
                        sm.notes.append(SrcNote(onset: snap(onset), duration: isGrace ? 1.0 / 16 : snap(dur), pitch: pitch,
                                                written: written, voice: el.text("voice") ?? "1",
                                                staff: Int(el.text("staff") ?? "1") ?? 1, grace: isGrace,
                                                tieStart: ties.contains("start") || ties.contains("continue"),
                                                tieStop: ties.contains("stop") || ties.contains("continue"), srcIndex: counter))
                    }
                    if !isChord && !isGrace { lastOnset = t; t += dur; maxT = max(maxT, t) }
                default:
                    break
                }
            }
            let nominal = Double(timeSig[0] * 4) / Double(timeSig[1])
            sm.length = maxT > 0 ? snap(maxT) : nominal
            sm.timeSig = timeSig
            sm.key = key
            sm.jumps = jumps(in: m)
            out.append(sm)
        }
        return out
    }

    static func jumps(in m: XMLTree.Node) -> [String: String] {
        var j: [String: String] = [:]
        for snd in m.descendants("sound") {
            for k in ["dacapo", "dalsegno", "segno", "fine", "tocoda", "coda"] {
                if let v = snd.attributes[k], v.lowercased() != "no" { j[k] = v }
            }
        }
        for w in m.descendants("words") {
            let t = w.textContent.lowercased().replacingOccurrences(of: " ", with: "")
            if t.isEmpty { continue }
            if (t.hasPrefix("d.c.") || t.hasPrefix("dacapo")) && j["dacapo"] == nil && j["dalsegno"] == nil { j["dacapo"] = "yes" }
            else if (t.hasPrefix("d.s.") || t.hasPrefix("dalsegno")) && j["dalsegno"] == nil && j["dacapo"] == nil { j["dalsegno"] = "segno" }
            else if (t == "fine" || t == "fine.") && j["fine"] == nil { j["fine"] = "yes" }
            else if (t.hasPrefix("tocoda") || t.hasPrefix("alcoda")) && j["tocoda"] == nil { j["tocoda"] = "coda" }
        }
        for dt in m.descendants("direction-type") {
            if dt.first("segno") != nil && j["segno"] == nil { j["segno"] = "segno" }
            if dt.first("coda") != nil && j["coda_sign"] == nil { j["coda_sign"] = "yes" }
        }
        return j
    }

    /// Performance order of printed measures (see score.py `unroll_repeats`).
    static func unroll(_ ms: [SrcMeasure], expand: Bool) -> [Int] {
        let n = ms.count
        guard expand, n > 0 else { return Array(0..<n) }
        var endingOf = [Set<Int>?](repeating: nil, count: n)
        var spanEnd = [Int](repeating: 0, count: n)
        var i = 0
        while i < n {
            if ms[i].endingStart {
                let nums = ms[i].endingNumbers ?? [1]
                var j = i
                while j < n - 1 && !ms[j].endingStop && !ms[j + 1].endingStart { j += 1 }
                for k in i...j { endingOf[k] = nums; spanEnd[k] = j }
                i = j + 1
            } else { i += 1 }
        }
        var segnoAt: [String: Int] = [:], codaAt: [String: Int] = [:], codaSigns: [Int] = []
        for (k, m) in ms.enumerated() {
            if let s = m.jumps["segno"] { segnoAt[s] = segnoAt[s] ?? k }
            if let c = m.jumps["coda"] { codaAt[c] = codaAt[c] ?? k }
            if m.jumps["coda_sign"] != nil { codaSigns.append(k) }
        }
        var order: [Int] = []
        var counts: [Int: Int] = [:]
        var sectionStart = 0, passNo = 1, voltaActive = false, jumped = false, guardCount = 0
        i = 0
        while i < n && guardCount < 40 * n + 100 {
            guardCount += 1
            let m = ms[i]
            if m.forward && i != sectionStart && !jumped { sectionStart = i; passNo = 1 }
            if endingOf[i] == nil && voltaActive { sectionStart = i; passNo = 1; voltaActive = false }
            if let nums = endingOf[i] {
                voltaActive = true
                let wanted = jumped ? (nums.max() ?? 1) : passNo
                if !nums.contains(wanted) { i = spanEnd[i] + 1; continue }
            }
            order.append(i)
            if jumped && m.jumps["fine"] != nil { break }
            if jumped, let name = m.jumps["tocoda"] {
                let target = codaAt[name] ?? codaSigns.filter { $0 > i }.last
                if let tgt = target, tgt > i { i = tgt; continue }
            }
            if m.backwardTimes > 0 && !jumped {
                let c = counts[i] ?? 0
                if c < m.backwardTimes - 1 {
                    counts[i] = c + 1; passNo += 1; voltaActive = false; i = sectionStart; continue
                }
                counts[i] = 0; sectionStart = i + 1; passNo = 1
            }
            if !jumped && (m.jumps["dacapo"] != nil || m.jumps["dalsegno"] != nil) {
                jumped = true
                var target = 0
                if let s = m.jumps["dalsegno"] { target = segnoAt[s] ?? segnoAt.values.min() ?? 0 }
                i = target; sectionStart = target; passNo = 1; voltaActive = false
                continue
            }
            i += 1
        }
        return order
    }

    static func build(root: XMLTree.Node, expandRepeats: Bool, fallbackTitle: String) throws -> PracticeScore {
        var title = root.first("work")?.text("work-title") ?? root.text("movement-title") ?? ""
        var composer = ""
        for c in root.first("identification")?.children ?? [] where c.name == "creator" && c.attributes["type"] == "composer" {
            composer = c.textContent.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if title.isEmpty {
            title = root.descendants("credit-words").map { $0.textContent.trimmingCharacters(in: .whitespacesAndNewlines) }
                .first(where: { $0.count > 1 }) ?? fallbackTitle
        }
        var parts: [PracticeScore.Part] = []
        var partOrder: [String] = []
        for sp in root.first("part-list")?.children ?? [] where sp.name == "score-part" {
            let id = sp.attributes["id"] ?? "P\(parts.count + 1)"
            let name = sp.text("part-name") ?? ""
            let instName = sp.first("score-instrument")?.text("instrument-name") ?? ""
            let prog = sp.first("midi-instrument")?.text("midi-program").flatMap { Int($0) }
            let prof = InstrumentLibrary.guess(partName: name + " " + instName, midiProgram: prog)
            parts.append(.init(id: id, name: name, instrument: prof.key, transpose: 0, midiProgram: prog))
        }
        var counter = 0
        var parsed: [(String, [SrcMeasure])] = []
        for part in root.children where part.name == "part" {
            let id = part.attributes["id"] ?? "P\(parsed.count + 1)"
            parsed.append((id, parsePart(part, counter: &counter)))
            partOrder.append(id)
            if !parts.contains(where: { $0.id == id }) { parts.append(.init(id: id, name: id)) }
        }
        guard !parsed.isEmpty else { throw ScoreError.unreadable("no <part> found") }
        let nMeas = parsed.map { $0.1.count }.max() ?? 0
        var merged: [SrcMeasure] = []
        for i in 0..<nMeas {
            let cands = parsed.compactMap { i < $0.1.count ? $0.1[i] : nil }
            var base = cands[0]
            base.length = cands.map { $0.length }.max() ?? base.length
            base.forward = cands.contains { $0.forward }
            base.backwardTimes = cands.map { $0.backwardTimes }.max() ?? 0
            base.endingStart = cands.contains { $0.endingStart }
            base.endingStop = cands.contains { $0.endingStop }
            base.endingNumbers = cands.compactMap { $0.endingNumbers }.first
            base.tempos = cands.flatMap { $0.tempos }
            var j: [String: String] = [:]
            for c in cands.reversed() { j.merge(c.jumps) { _, new in new } }
            base.jumps = j
            merged.append(base)
        }
        for (pid, ms) in parsed {
            if let nt = ms.lazy.flatMap({ $0.notes }).first(where: { $0.pitch != nil && $0.written != nil }),
               let idx = parts.firstIndex(where: { $0.id == pid }) {
                parts[idx].transpose = nt.pitch! - nt.written!
            }
        }
        let order = unroll(merged, expand: expandRepeats)
        var measures: [PracticeScore.Measure] = []
        var notes: [PracticeScore.Note] = []
        var tempos: [(Double, Double)] = []
        var start = 0.0
        var openTies: [String: Int] = [:]     // key -> index into notes
        for (k, s) in order.enumerated() {
            let sm = merged[s]
            measures.append(.init(index: k, label: sm.number, start: start, duration: sm.length, timeSignature: sm.timeSig,
                                  keyFifths: sm.key.0, keyMode: sm.key.1, sourceIndex: s))
            for (on, q) in sm.tempos { tempos.append((start + on, q)) }
            for (pid, ms) in parsed where s < ms.count {
                for sn in ms[s].notes.sorted(by: { ($0.onset, $0.srcIndex) < ($1.onset, $1.srcIndex) }) {
                    let onset = start + sn.onset
                    let key = "\(pid)|\(sn.staff)|\(sn.pitch ?? -1)"
                    if sn.tieStop, sn.pitch != nil, let idx = openTies[key] {
                        let prev = notes[idx]
                        if prev.onset < onset && onset <= prev.onset + prev.duration + 1.0 {
                            notes[idx].duration = onset + sn.duration - prev.onset
                            if !sn.tieStart { openTies[key] = nil }
                            continue
                        }
                    }
                    notes.append(.init(id: "\(pid)-\(k)-\(sn.srcIndex)", part: pid, measure: k, onset: onset,
                                       duration: sn.duration, pitch: sn.pitch, written: sn.written, voice: sn.voice,
                                       staff: sn.staff, grace: sn.grace, sourceIndex: sn.srcIndex))
                    if sn.tieStart && sn.pitch != nil { openTies[key] = notes.count - 1 }
                }
            }
            start += sm.length
        }
        notes.sort { ($0.onset, $0.part, $0.pitch ?? 0) < ($1.onset, $1.part, $1.pitch ?? 0) }
        var tempoList: [[Double]] = []
        for (b, q) in tempos.sorted(by: { $0.0 < $1.0 }) {
            if let last = tempoList.last, abs(last[0] - b) < 1e-9 { tempoList[tempoList.count - 1] = [b, q] }
            else if tempoList.last.map({ abs($0[1] - q) > 1e-6 }) ?? true { tempoList.append([b, q]) }
        }
        return PracticeScore(title: title, composer: composer, parts: parts, measures: measures,
                             tempos: tempoList.isEmpty ? [[0, 100]] : tempoList, notes: notes,
                             source: .object(["format": .string("musicxml"),
                                              "repeats_expanded": .bool(expandRepeats),
                                              "printed_measures": .number(Double(merged.count))]))
    }
}

/// A tiny DOM on top of Foundation's streaming XMLParser.
public enum XMLTree {
    public final class Node {
        public let name: String
        public var attributes: [String: String]
        public var children: [Node] = []
        var textBuffer = ""
        init(name: String, attributes: [String: String]) { self.name = name; self.attributes = attributes }

        public var textContent: String { textBuffer + children.map { $0.textContent }.joined() }
        public func first(_ name: String) -> Node? { children.first { $0.name == name } }
        public func text(_ name: String) -> String? {
            first(name).map { $0.textContent.trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        public func descendants(_ name: String) -> [Node] {
            var out: [Node] = []
            for c in children {
                if c.name == name { out.append(c) }
                out.append(contentsOf: c.descendants(name))
            }
            return out
        }
    }

    final class Builder: NSObject, XMLParserDelegate {
        var stack: [Node] = []
        var root: Node?
        func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
                    qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]) {
            let local = elementName.split(separator: ":").last.map(String.init) ?? elementName
            let n = Node(name: local, attributes: attributeDict)
            stack.last?.children.append(n)
            if root == nil { root = n }
            stack.append(n)
        }
        func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
            _ = stack.popLast()
        }
        func parser(_ parser: XMLParser, foundCharacters string: String) {
            stack.last?.textBuffer += string
        }
    }

    public static func parse(_ data: Data) -> Node? {
        let p = XMLParser(data: data)
        p.shouldResolveExternalEntities = false
        let b = Builder()
        p.delegate = b
        return p.parse() ? b.root : (b.root?.children.isEmpty == false ? b.root : nil)
    }
}
