import Foundation

/// Instrument profile, decoded from `instruments.json` (exported by the Python engine so both agree).
public struct InstrumentProfile: Codable, Hashable, Sendable, Identifiable {
    public var id: String { key }
    public let key: String
    public let name: String
    public let family: String
    public let low: Int
    public let high: Int
    public let transpose: Int
    public let mode: String              // mono | poly | rhythm
    public let maxPolyphony: Int
    public let intonation: Bool
    public let centsOK: Double
    public let centsWarn: Double
    public let onsetStyle: String
    public let minNoteMs: Double
    public let openStrings: [Int]
    public let vibrato: Bool
    public let chordSpreadMs: Double

    enum CodingKeys: String, CodingKey {
        case key, name, family, low, high, transpose, mode, intonation, vibrato
        case maxPolyphony = "max_polyphony", centsOK = "cents_ok", centsWarn = "cents_warn"
        case onsetStyle = "onset_style", minNoteMs = "min_note_ms", openStrings = "open_strings"
        case chordSpreadMs = "chord_spread_ms"
    }

    public var isPoly: Bool { mode == "poly" }
    public var isRhythm: Bool { mode == "rhythm" }
    public var fMin: Double { Pitch.hz(midi: Double(low - 2)) }
    public var fMax: Double { Pitch.hz(midi: Double(high + 2)) }
}

public enum Pitch {
    public static func hz(midi: Double, a4: Double = 440) -> Double { a4 * pow(2, (midi - 69) / 12) }
    public static func midi(hz: Double, a4: Double = 440) -> Double { 69 + 12 * log2(hz / a4) }
}

public enum InstrumentLibrary {
    private struct File: Codable { let schema: String; let instruments: [InstrumentProfile] }

    public static let all: [InstrumentProfile] = {
        if let url = Bundle.module.url(forResource: "instruments", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let f = try? JSONDecoder().decode(File.self, from: data), !f.instruments.isEmpty {
            return f.instruments
        }
        return []
    }()

    public static func profile(_ key: String?) -> InstrumentProfile {
        let k = (key ?? "piano").lowercased()
        if let p = all.first(where: { $0.key == k }) { return p }
        let aliases = ["voice": "voice_soprano", "vocal": "voice_soprano", "sax": "alto_sax", "drums": "percussion",
                       "horn": "french_horn", "bass": "voice_bass"]
        if let a = aliases[k], let p = all.first(where: { $0.key == a }) { return p }
        return all.first(where: { $0.key == "piano" }) ?? all[0]
    }

    /// Same heuristics as instruments.py `guess_profile`.
    public static func guess(partName: String, midiProgram: Int?) -> InstrumentProfile {
        let name = partName.lowercased()
        let keywords: [(String, String)] = [
            ("piano", "piano"), ("keyboard", "keyboard"), ("violin", "violin"), ("viola", "viola"), ("cello", "cello"),
            ("contrabass", "double_bass"), ("double bass", "double_bass"), ("bass guitar", "bass_guitar"),
            ("guitar", "guitar"), ("ukulele", "ukulele"), ("soprano", "voice_soprano"), ("alto sax", "alto_sax"),
            ("tenor sax", "tenor_sax"), ("alto", "voice_alto"), ("tenor", "voice_tenor"), ("bass", "voice_bass"),
            ("baritone", "voice_bass"), ("voice", "voice_soprano"), ("vocal", "voice_soprano"), ("flute", "flute"),
            ("recorder", "recorder"), ("clarinet", "clarinet"), ("trumpet", "trumpet"), ("trombone", "trombone"),
            ("horn", "french_horn"), ("erhu", "erhu"), ("二胡", "erhu"), ("dizi", "dizi"), ("笛", "dizi"),
            ("guzheng", "guzheng"), ("古筝", "guzheng"), ("drum", "percussion"), ("percussion", "percussion"),
        ]
        for (word, key) in keywords where name.contains(word) { return profile(key) }
        if let gm = midiProgram {
            switch gm {
            case 1...8: return profile("piano")
            case 25...32: return profile("guitar")
            case 33...40: return profile("bass_guitar")
            case 41: return profile("violin")
            case 42: return profile("viola")
            case 43: return profile("cello")
            case 44: return profile("double_bass")
            case 53...55: return profile("voice_soprano")
            case 57: return profile("trumpet")
            case 58: return profile("trombone")
            case 61: return profile("french_horn")
            case 66: return profile("alto_sax")
            case 67: return profile("tenor_sax")
            case 72: return profile("clarinet")
            case 74: return profile("flute")
            case 75: return profile("recorder")
            default: break
            }
        }
        return profile("piano")
    }
}
