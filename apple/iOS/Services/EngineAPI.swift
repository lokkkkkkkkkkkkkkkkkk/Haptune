import Foundation
import PracticeCore

/// Client for the Haptune analysis server (server/app.py). Used for PDF/photo import (OMR),
/// recording -> score, band split, ABC/MEI import and the full post-take report.
struct EngineAPI {
    var baseURL: URL

    struct ScorePayload: Decodable {
        let score: PracticeScore
        let musicxml: String?
    }

    struct Job: Decodable {
        let id: String
        let status: String          // queued | running | done | error
        let stage: String?
        let progress: Double?
        let message: String?
    }

    struct SplitPayload: Decodable {
        struct Part: Decodable {
            let id: String
            let name: String
            let instrument: String
            let role: String
            let file: String
            let scorePart: String?
            let activity: [Double]
            enum CodingKeys: String, CodingKey { case id, name, instrument, role, file, activity; case scorePart = "score_part" }
        }
        struct Chord: Decodable { let beat: Double; let label: String }
        let title: String
        let bpm: Double?
        let key: String?
        let duration: Double
        let offset: Double?
        let parts: [Part]
        let chords: [Chord]?
        let score: PracticeScore
        let musicxml: String?
    }

    enum APIError: LocalizedError {
        case server(Int, String), failed(String)
        var errorDescription: String? {
            switch self {
            case .server(let code, let msg): return String(localized: "Server error \(code): \(msg)")
            case .failed(let msg): return msg
            }
        }
    }

    /// An anonymous id for this install, so the server can share out free AI reads fairly. It isn't linked to the person.
    static var deviceID: String {
        let d = UserDefaults.standard
        if let id = d.string(forKey: "haptune.device"), !id.isEmpty { return id }
        let id = UUID().uuidString
        d.set(id, forKey: "haptune.device")
        return id
    }

    private func request(_ path: String, method: String = "GET", timeout: TimeInterval = 60) -> URLRequest {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.timeoutInterval = timeout
        req.setValue(Self.deviceID, forHTTPHeaderField: "X-Haptune-Device")
        return req
    }

    func health() async -> Bool {
        guard let (_, resp) = try? await URLSession.shared.data(for: request("health", timeout: 8)),
              let http = resp as? HTTPURLResponse else { return false }
        return http.statusCode == 200
    }

    func importScore(file: URL) async throws -> ScorePayload {
        try await upload(path: "score/import", files: [("file", file)], fields: [:], as: ScorePayload.self)
    }

    func transcribe(recording: URL, instrument: String, bpm: Double? = nil) async throws -> ScorePayload {
        var fields = ["instrument": instrument]
        if let bpm { fields["bpm"] = String(bpm) }
        return try await upload(path: "score/transcribe", files: [("file", recording)], fields: fields, as: ScorePayload.self)
    }

    /// Full report for one take. Returns the HTML page (coloured score, charts, practice plan).
    func analyzeHTML(score: PracticeScore, take: URL, instrument: String, targetQPM: Double?, metronome: Bool,
                     level: String) async throws -> String {
        var fields = ["instrument": instrument, "format": "html", "level": level, "metronome": metronome ? "true" : "false",
                      "score_json": String(decoding: try score.encoded(), as: UTF8.self)]
        if let q = targetQPM { fields["target_qpm"] = String(q) }
        let data = try await uploadRaw(path: "analyze", files: [("audio", take)], fields: fields)
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: band split (long-running job)

    func startSplit(recording: URL, instruments: [String], title: String) async throws -> String {
        struct Started: Decodable { let id: String }
        let fields = ["instruments": instruments.joined(separator: ","), "title": title]
        return try await upload(path: "jobs/split", files: [("file", recording)], fields: fields, as: Started.self).id
    }

    func job(_ id: String) async throws -> Job {
        let (data, resp) = try await URLSession.shared.data(for: request("jobs/\(id)", timeout: 30))
        try check(resp, data)
        return try JSONDecoder().decode(Job.self, from: data)
    }

    func splitResult(_ id: String) async throws -> SplitPayload {
        let (data, resp) = try await URLSession.shared.data(for: request("jobs/\(id)/result"))
        try check(resp, data)
        return try JSONDecoder().decode(SplitPayload.self, from: data)
    }

    func download(job id: String, file: String) async throws -> URL {
        let (tmp, resp) = try await URLSession.shared.download(for: request("jobs/\(id)/files/\(file)", timeout: 300))
        try check(resp, Data())
        let dst = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + (file as NSString).lastPathComponent)
        try FileManager.default.moveItem(at: tmp, to: dst)
        return dst
    }

    // MARK: AI: read sheet music, find songs online

    struct AIStatus: Decodable {
        let ai: Bool
        let maxPages: Int?
        enum CodingKeys: String, CodingKey { case ai; case maxPages = "max_pages" }
    }

    /// nil when the server can't be reached; `ai` is false when the server has no AI key yet.
    func aiStatus() async -> AIStatus? {
        guard let (data, resp) = try? await URLSession.shared.data(for: request("ai/status", timeout: 10)),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(AIStatus.self, from: data)
    }

    struct ReadPayload: Decodable {
        struct Flag: Decodable {
            let bar: Int?
            let page: Int?
            let reasons: [String]?
        }
        let musicxml: String
        let flags: [Flag]
    }

    /// Starts reading sheet music with AI (a PDF, or photos of the pages in order). Returns the job id.
    func startRead(files: [URL], title: String = "", instrument: String = "", handwritten: Bool = false) async throws -> String {
        struct Started: Decodable { let id: String }
        var parts: [(String, URL)] = []
        for (i, f) in files.enumerated() { parts.append((i == 0 ? "file" : "more", f)) }
        var fields: [String: String] = [:]
        if !title.isEmpty { fields["title"] = title }
        if !instrument.isEmpty { fields["instrument"] = instrument }
        if handwritten { fields["handwritten"] = "true" }
        return try await upload(path: "ai/read", files: parts, fields: fields, as: Started.self).id
    }

    func readResult(_ id: String) async throws -> ReadPayload {
        let (data, resp) = try await URLSession.shared.data(for: request("jobs/\(id)/result"))
        try check(resp, data)
        return try JSONDecoder().decode(ReadPayload.self, from: data)
    }

    /// Reads sheet music with AI and waits for the result, reporting progress (0...1) and what it is doing.
    func readSheetMusic(files: [URL], title: String = "", instrument: String = "",
                        progress: @escaping @MainActor (Double, String) -> Void) async throws -> ReadPayload {
        let id = try await startRead(files: files, title: title, instrument: instrument)
        var wait: UInt64 = 900_000_000
        while true {
            try await Task.sleep(nanoseconds: wait)
            wait = min(2_000_000_000, wait + 150_000_000)
            let j = try await job(id)
            await progress(j.progress ?? 0, j.message ?? "")
            if j.status == "done" { return try await readResult(id) }
            if j.status == "error" { throw APIError.failed(j.message ?? String(localized: "The music could not be read.")) }
        }
    }

    struct FindPayload: Decodable {
        struct Song: Decodable {
            let title: String
            let artist: String
            let copyrighted: Bool?
        }
        struct Candidate: Decodable, Identifiable, Hashable {
            let title: String
            let arrangement: String?
            let instrument: String?
            let level: String?
            let format: String
            let fileURL: String?
            let pageURL: String
            let source: String?
            let license: String?
            let pages: Int?
            let verified: Bool?
            var id: String { (fileURL ?? "") + "|" + pageURL }
            /// A file Haptune can download and open (not just a web page about it).
            var canImport: Bool { fileURL != nil && format != "page" }
            enum CodingKeys: String, CodingKey {
                case title, arrangement, instrument, level, format, source, license, pages, verified
                case fileURL = "file_url", pageURL = "page_url"
            }
        }
        let song: Song
        let candidates: [Candidate]
        let advice: String?
        let youtubeID: String?
        enum CodingKeys: String, CodingKey { case song, candidates, advice; case youtubeID = "youtube_id" }
    }

    /// Searches the web for sheet music of a song (by name, or from a YouTube / Spotify / Apple Music link).
    func findMusic(query: String, link: String, instrument: String) async throws -> FindPayload {
        var req = request("ai/find", method: "POST", timeout: 240)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["query": query, "link": link, "instrument": instrument])
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try JSONDecoder().decode(FindPayload.self, from: data)
    }

    /// Downloads a found file through the server, which checks the link is safe and really is sheet music.
    func fetchMusicFile(_ url: String) async throws -> URL {
        var comps = URLComponents(url: baseURL.appendingPathComponent("ai/fetch"), resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "url", value: url)]
        guard let full = comps?.url else { throw APIError.failed(String(localized: "That link can't be opened.")) }
        var req = URLRequest(url: full)
        req.timeoutInterval = 90
        req.setValue(Self.deviceID, forHTTPHeaderField: "X-Haptune-Device")
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        var name = URL(string: url)?.lastPathComponent ?? ""
        if let cd = (resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition"),
           let r = cd.range(of: "filename=\"") {
            let rest = cd[r.upperBound...]
            if let end = rest.firstIndex(of: "\"") { name = String(rest[..<end]) }
        }
        if name.isEmpty || !name.contains(".") { name = "download.musicxml" }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dst = dir.appendingPathComponent(name)
        try data.write(to: dst)
        return dst
    }

    // MARK: multipart

    private func check(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) else { return }
        struct Detail: Decodable { let detail: String }
        if let d = try? JSONDecoder().decode(Detail.self, from: data) { throw APIError.failed(d.detail) }   // the server's own message
        throw APIError.server(http.statusCode, String(decoding: data.prefix(300), as: UTF8.self))
    }

    private func upload<T: Decodable>(path: String, files: [(String, URL)], fields: [String: String], as: T.Type) async throws -> T {
        let data = try await uploadRaw(path: path, files: files, fields: fields)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func uploadRaw(path: String, files: [(String, URL)], fields: [String: String]) async throws -> Data {
        let boundary = "haptune-\(UUID().uuidString)"
        var body = Data()
        func add(_ s: String) { body.append(Data(s.utf8)) }
        for (k, v) in fields {
            add("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n")
        }
        for (name, url) in files {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let fileData = try Data(contentsOf: url)
            add("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(url.lastPathComponent)\"\r\n")
            add("Content-Type: application/octet-stream\r\n\r\n")
            body.append(fileData)
            add("\r\n")
        }
        add("--\(boundary)--\r\n")
        var req = request(path, method: "POST", timeout: 600)
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let (data, resp) = try await URLSession.shared.upload(for: req, from: body)
        try check(resp, data)
        return data
    }
}
