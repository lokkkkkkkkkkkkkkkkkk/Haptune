import Foundation
import PracticeCore
import UniformTypeIdentifiers

/// Turns any supported file into a library entry. MusicXML, MIDI and jianpu are read on the device;
/// PDF / photos (read by AI when the server has it, otherwise classic OMR), ABC / MEI / Humdrum and
/// recordings go to the analysis server.
struct Importer {
    var api: EngineAPI?
    /// Called while the AI reads sheet music: how far along (0...1) and what it is doing.
    var progress: (@MainActor (Double, String) -> Void)? = nil

    struct Result {
        var score: PracticeScore
        var musicXML: String?
        var kind: String
        /// Bars the AI reader wasn't sure about (1-based), to check against the paper.
        var unsureBars: [Int] = []
    }

    enum Kind { case score, image, recording, unknown }

    static let musicXMLTypes = ["musicxml", "xml", "mxl"]
    static let midiTypes = ["mid", "midi", "kar"]
    static let serverScoreTypes = ["abc", "mei", "krn", "kern"]
    static let imageTypes = ["pdf", "png", "jpg", "jpeg", "heic", "heif", "tif", "tiff"]
    static let audioTypes = ["wav", "m4a", "mp3", "aac", "caf", "aiff", "aif", "flac", "ogg", "opus", "mp4", "mov", "m4v", "3gp", "webm"]

    /// Everything the import buttons accept.
    static let contentTypes: [UTType] = {
        var t: [UTType] = [.pdf, .png, .jpeg, .heic, .tiff, .image, .xml, .json, .plainText, .audio, .movie, .mpeg4Movie,
                           .quickTimeMovie, .mpeg4Audio, .mp3, .wav, .aiff, .midi]
        for ext in ["musicxml", "mxl", "jianpu", "abc", "mei", "krn", "flac", "ogg", "opus"] {
            if let u = UTType(filenameExtension: ext) { t.append(u) }
        }
        return t
    }()

    static let recordingTypes: [UTType] = {
        var t: [UTType] = [.audio, .movie, .mpeg4Movie, .quickTimeMovie, .mpeg4Audio, .mp3, .wav, .aiff]
        for ext in ["flac", "ogg", "opus"] { if let u = UTType(filenameExtension: ext) { t.append(u) } }
        return t
    }()

    static func kind(of url: URL) -> Kind {
        let ext = url.pathExtension.lowercased()
        if musicXMLTypes.contains(ext) || midiTypes.contains(ext) || serverScoreTypes.contains(ext)
            || ["txt", "jianpu", "json"].contains(ext) { return .score }
        if imageTypes.contains(ext) { return .image }
        if audioTypes.contains(ext) { return .recording }
        return .unknown
    }

    func importFile(_ url: URL, instrument: InstrumentProfile) async throws -> Result {
        let ext = url.pathExtension.lowercased()
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = url.deletingPathExtension().lastPathComponent
        switch ext {
        case _ where Self.musicXMLTypes.contains(ext):
            let data = try Data(contentsOf: url)
            let s = try MusicXMLParser.parse(data: data, fallbackTitle: name)
            let xml = String(decoding: try MusicXMLParser.unzipIfNeeded(data), as: UTF8.self)
            return Result(score: s, musicXML: xml, kind: "musicxml")
        case _ where Self.midiTypes.contains(ext):
            let s = try MIDIFile.parse(data: Data(contentsOf: url), fallbackTitle: name)
            return Result(score: s, musicXML: MusicXMLWriter.write(s), kind: "midi")
        case "txt", "jianpu":
            let text = try String(contentsOf: url, encoding: .utf8)
            let s = try Jianpu.parse(text, instrument: instrument.key)
            return Result(score: s, musicXML: MusicXMLWriter.write(s), kind: "jianpu")
        case "json":
            let s = try PracticeScore.decode(Data(contentsOf: url))
            return Result(score: s, musicXML: nil, kind: "json")
        case _ where Self.imageTypes.contains(ext):
            guard let api else { throw ImportError.needsServer }
            let kind = ext == "pdf" ? "pdf" : "photo"
            if let status = await api.aiStatus(), status.ai {
                // AI reads every note, rest, tie, dynamic and articulation, checks each bar, and writes MusicXML
                let report: @MainActor (Double, String) -> Void = progress ?? { _, _ in }
                let r = try await api.readSheetMusic(files: [url], title: name, instrument: instrument.key, progress: report)
                let s = try MusicXMLParser.parse(data: Data(r.musicxml.utf8), fallbackTitle: name)
                return Result(score: s, musicXML: r.musicxml, kind: kind, unsureBars: r.flags.compactMap { $0.bar })
            }
            let p = try await api.importScore(file: url)
            return Result(score: p.score, musicXML: p.musicxml, kind: kind)
        case _ where Self.serverScoreTypes.contains(ext):
            guard let api else { throw ImportError.needsServer }
            let p = try await api.importScore(file: url)
            return Result(score: p.score, musicXML: p.musicxml, kind: ext)
        case _ where Self.audioTypes.contains(ext):
            guard let api else { throw ImportError.needsServer }
            let p = try await api.transcribe(recording: url, instrument: instrument.key)
            return Result(score: p.score, musicXML: p.musicxml, kind: "recording")
        default:
            throw ImportError.unsupported(ext)
        }
    }

    /// Copies a picked/shared file into a temporary place we can keep using after the picker closes.
    static func temporaryCopy(of url: URL) throws -> URL {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dst = dir.appendingPathComponent(url.lastPathComponent)
        try FileManager.default.copyItem(at: url, to: dst)
        return dst
    }
}

enum ImportError: LocalizedError {
    case needsServer, unsupported(String), noSound

    var errorDescription: String? {
        switch self {
        case .needsServer:
            return String(localized: "This file is read by Melovyn's online service, which isn't available right now. Please try again later.")
        case .unsupported(let ext):
            return String(localized: "Melovyn can't open .\(ext) files yet.")
        case .noSound:
            return String(localized: "The recording is silent.")
        }
    }
}
