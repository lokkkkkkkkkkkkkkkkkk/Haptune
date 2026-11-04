import Foundation
import ZIPFoundation

/// Standard MIDI File (.mid / .midi, format 0 or 1) -> PracticeScore, on the device.
/// Tracks (format 1) or channels (format 0) become parts; tempo, time and key signatures are read
/// from the meta events; notes are snapped to a 1/48-beat grid so exported notation stays readable.
public enum MIDIFile {
    struct RawNote { var track: Int; var channel: Int; var pitch: Int; var on: Int; var off: Int; var velocity: Int }

    public static func parse(data: Data, fallbackTitle: String = "") throws -> PracticeScore {
        let b = [UInt8](data)
        var pos = 0
        func u16() throws -> Int {
            guard pos + 2 <= b.count else { throw ScoreError.unreadable("truncated MIDI file") }
            defer { pos += 2 }
            return Int(b[pos]) << 8 | Int(b[pos + 1])
        }
        func u32() throws -> Int {
            guard pos + 4 <= b.count else { throw ScoreError.unreadable("truncated MIDI file") }
            defer { pos += 4 }
            return Int(b[pos]) << 24 | Int(b[pos + 1]) << 16 | Int(b[pos + 2]) << 8 | Int(b[pos + 3])
        }
        func tag() throws -> String {
            guard pos + 4 <= b.count else { throw ScoreError.unreadable("truncated MIDI file") }
            defer { pos += 4 }
            return String(decoding: b[pos..<pos + 4], as: UTF8.self)
        }
        guard try tag() == "MThd" else { throw ScoreError.unreadable("not a MIDI file") }
        let headerLength = try u32()
        let format = try u16()
        let trackCount = try u16()
        let division = try u16()
        pos = 8 + headerLength
        guard division & 0x8000 == 0, division > 0 else { throw ScoreError.unsupported("SMPTE-timed MIDI files") }
        let tpq = Double(division)

        var notes: [RawNote] = []
        var tempos: [(tick: Int, qpm: Double)] = []
        var timeSigs: [(tick: Int, num: Int, den: Int)] = []
        var keySigs: [(tick: Int, fifths: Int, minor: Bool)] = []
        var trackNames: [Int: String] = [:]
        var programs: [Int: Int] = [:]             // track*16+channel -> GM program (0-based)

        var track = 0
        while track < trackCount, pos + 8 <= b.count {
            let t = try tag()
            let length = try u32()
            let end = min(b.count, pos + length)
            guard t == "MTrk" else { pos = end; continue }
            var tick = 0
            var running: UInt8 = 0
            var open: [Int: [(Int, Int)]] = [:]      // channel*128+pitch -> stack of (tick, velocity)
            func vlq() -> Int {
                var v = 0
                while pos < end {
                    let c = b[pos]; pos += 1
                    v = (v << 7) | Int(c & 0x7F)
                    if c & 0x80 == 0 { break }
                }
                return v
            }
            while pos < end {
                tick += vlq()
                guard pos < end else { break }
                var status = b[pos]
                if status & 0x80 != 0 { pos += 1; if status < 0xF0 { running = status } } else { status = running }
                switch status {
                case 0xFF:
                    guard pos < end else { break }
                    let metaType = b[pos]; pos += 1
                    let len = vlq()
                    let d = Array(b[pos..<min(end, pos + len)])
                    pos = min(end, pos + len)
                    switch metaType {
                    case 0x51 where d.count == 3:
                        let us = Int(d[0]) << 16 | Int(d[1]) << 8 | Int(d[2])
                        if us > 0 { tempos.append((tick, 60_000_000.0 / Double(us))) }
                    case 0x58 where d.count >= 2:
                        timeSigs.append((tick, Int(d[0]), 1 << Int(d[1])))
                    case 0x59 where d.count >= 2:
                        keySigs.append((tick, Int(Int8(bitPattern: d[0])), d[1] == 1))
                    case 0x03:
                        if trackNames[track] == nil { trackNames[track] = String(decoding: d, as: UTF8.self) }
                    default: break
                    }
                case 0xF0, 0xF7:
                    let len = vlq()
                    pos = min(end, pos + len)
                default:
                    let kind = status & 0xF0
                    let ch = Int(status & 0x0F)
                    let need = (kind == 0xC0 || kind == 0xD0) ? 1 : 2
                    guard pos + need <= end else { pos = end; break }
                    let d1 = Int(b[pos]), d2 = need == 2 ? Int(b[pos + 1]) : 0
                    pos += need
                    let key = ch * 128 + d1
                    if kind == 0x90 && d2 > 0 {
                        open[key, default: []].append((tick, d2))
                    } else if kind == 0x80 || (kind == 0x90 && d2 == 0) {
                        if var stack = open[key], !stack.isEmpty {
                            let (on, vel) = stack.removeFirst()
                            open[key] = stack
                            if tick > on { notes.append(RawNote(track: track, channel: ch, pitch: d1, on: on, off: tick, velocity: vel)) }
                        }
                    } else if kind == 0xC0 {
                        if programs[track * 16 + ch] == nil { programs[track * 16 + ch] = d1 }
                    }
                }
            }
            for (key, stack) in open {           // notes never released: end them at the track end
                for (on, vel) in stack where tick > on {
                    notes.append(RawNote(track: track, channel: key / 128, pitch: key % 128, on: on, off: tick, velocity: vel))
                }
            }
            pos = end
            track += 1
        }
        guard !notes.isEmpty else { throw ScoreError.unreadable("no notes in the MIDI file") }

        // parts: format 1 -> one per track (and per channel if a track mixes channels); format 0 -> per channel
        func partKey(_ n: RawNote) -> Int { format == 0 ? n.channel : n.track * 16 + n.channel }
        let keys = Array(Set(notes.map(partKey))).sorted()
        var parts: [PracticeScore.Part] = []
        var partID: [Int: String] = [:]
        for (i, k) in keys.enumerated() {
            let id = "P\(i + 1)"
            partID[k] = id
            let channel = format == 0 ? k : k % 16
            let trackIndex = format == 0 ? 0 : k / 16
            let program = programs[k]
            let name = trackNames[trackIndex].flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
            let profile: InstrumentProfile = channel == 9 ? InstrumentLibrary.profile("percussion")
                : InstrumentLibrary.guess(partName: name ?? "", midiProgram: program.map { $0 + 1 })
            parts.append(.init(id: id, name: name ?? profile.name, instrument: profile.key, transpose: 0,
                               midiProgram: program.map { $0 + 1 }))
        }

        let grid = 48.0
        func beats(_ tick: Int) -> Double { (Double(tick) / tpq * grid).rounded() / grid }
        let endBeat = notes.map { beats($0.off) }.max() ?? 4

        // measures from the time signatures (default 4/4)
        let sigs = (timeSigs.isEmpty ? [(tick: 0, num: 4, den: 4)] : timeSigs.sorted { $0.tick < $1.tick })
        let keyList = keySigs.sorted { $0.tick < $1.tick }
        var measures: [PracticeScore.Measure] = []
        var start = 0.0
        var si = 0
        while start < endBeat - 1e-6 || measures.isEmpty {
            while si + 1 < sigs.count && beats(sigs[si + 1].tick) <= start + 1e-6 { si += 1 }
            let sig = sigs[si]
            let len = Double(sig.num) * 4.0 / Double(max(1, sig.den))
            let k = keyList.last(where: { beats($0.tick) <= start + 1e-6 }) ?? keyList.first
            measures.append(.init(index: measures.count, label: String(measures.count + 1), start: start, duration: len,
                                  timeSignature: [sig.num, sig.den], keyFifths: k?.fifths ?? 0,
                                  keyMode: (k?.minor ?? false) ? "minor" : "major"))
            start += len
            if measures.count > 5000 { break }
        }
        func measureIndex(_ beat: Double) -> Int {
            var lo = 0, hi = measures.count - 1
            while lo < hi {
                let mid = (lo + hi + 1) / 2
                if measures[mid].start <= beat + 1e-9 { lo = mid } else { hi = mid - 1 }
            }
            return lo
        }

        let sorted = notes.sorted { ($0.on, $0.pitch) < ($1.on, $1.pitch) }
        var out: [PracticeScore.Note] = []
        for (i, n) in sorted.enumerated() {
            let on = beats(n.on)
            let dur = max(1.0 / 12.0, beats(n.off) - on)
            let pid = partID[partKey(n)] ?? "P1"
            let drum = n.channel == 9
            out.append(.init(id: "M-\(i)", part: pid, measure: measureIndex(on), onset: on, duration: dur,
                             pitch: drum ? nil : n.pitch, written: drum ? nil : n.pitch, voice: "1",
                             staff: 1, grace: false, sourceIndex: i + 1))
        }
        let qpms = tempos.sorted { $0.tick < $1.tick }.map { [beats($0.tick), ($0.qpm * 10).rounded() / 10] }
        let title = trackNames[0].flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? fallbackTitle
        return PracticeScore(title: title, composer: "", parts: parts, measures: measures,
                             tempos: qpms.isEmpty ? [[0, 120]] : qpms, notes: out,
                             source: .object(["format": .string("midi")]))
    }
}

/// Zips / unzips a folder (library backups that travel through Files, Google Drive, Dropbox, OneDrive).
public enum FolderArchive {
    public static func zip(directory: URL, to archive: URL) throws {
        try? FileManager.default.removeItem(at: archive)
        try FileManager.default.zipItem(at: directory, to: archive, shouldKeepParent: false, compressionMethod: .deflate)
    }

    public static func unzip(_ archive: URL, to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try FileManager.default.unzipItem(at: archive, to: directory)
    }
}
