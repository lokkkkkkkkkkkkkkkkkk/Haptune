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

    func health() async -> Bool {
        var req = URLRequest(url: baseURL.appendingPathComponent("health"))
        req.timeoutInterval = 8
        guard let (_, resp) = try? await URLSession.shared.data(for: req), let http = resp as? HTTPURLResponse else { return false }
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
        let (data, resp) = try await URLSession.shared.data(from: baseURL.appendingPathComponent("jobs/\(id)"))
        try check(resp, data)
        return try JSONDecoder().decode(Job.self, from: data)
    }

    func splitResult(_ id: String) async throws -> SplitPayload {
        let (data, resp) = try await URLSession.shared.data(from: baseURL.appendingPathComponent("jobs/\(id)/result"))
        try check(resp, data)
        return try JSONDecoder().decode(SplitPayload.self, from: data)
    }

    func download(job id: String, file: String) async throws -> URL {
        let (tmp, resp) = try await URLSession.shared.download(from: baseURL.appendingPathComponent("jobs/\(id)/files/\(file)"))
        try check(resp, Data())
        let dst = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + (file as NSString).lastPathComponent)
        try FileManager.default.moveItem(at: tmp, to: dst)
        return dst
    }

    // MARK: multipart

    private func check(_ resp: URLResponse, _ data: Data) throws {
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw APIError.server(http.statusCode, String(decoding: data.prefix(300), as: UTF8.self))
        }
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
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.timeoutInterval = 600
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let (data, resp) = try await URLSession.shared.upload(for: req, from: body)
        try check(resp, data)
        return data
    }
}
