import Foundation
import PracticeCore
import SwiftUI

/// Runs a band split on the server: upload -> separate -> transcribe -> download parts -> library item.
@MainActor
final class SplitCenter: ObservableObject {
    enum Phase: Equatable {
        case idle
        case uploading
        case working(stage: String, progress: Double)
        case finished(UUID)
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var sourceName = ""
    private var task: Task<Void, Never>?

    var isBusy: Bool {
        switch phase {
        case .uploading, .working: return true
        default: return false
        }
    }

    func start(file: URL, instruments: [String], title: String, api: EngineAPI, library: Library, link: SongLink? = nil) {
        task?.cancel()
        sourceName = title
        phase = .uploading
        task = Task {
            do {
                let id = try await api.startSplit(recording: file, instruments: instruments, title: title)
                phase = .working(stage: "queued", progress: 0)
                while true {
                    try await Task.sleep(nanoseconds: 1_500_000_000)
                    let j = try await api.job(id)
                    if j.status == "done" { break }
                    if j.status == "error" { throw EngineAPI.APIError.failed(j.message ?? String(localized: "The split did not finish.")) }
                    phase = .working(stage: j.stage ?? j.status, progress: j.progress ?? 0)
                }
                phase = .working(stage: "downloading", progress: 1)
                let r = try await api.splitResult(id)
                var stems: [String: URL] = [:]
                for p in r.parts {
                    stems[(p.file as NSString).lastPathComponent] = try await api.download(job: id, file: p.file)
                }
                let info = SplitInfo(
                    bpm: r.bpm, key: r.key, duration: r.duration, offset: r.offset ?? 0,
                    parts: r.parts.map {
                        SplitPart(id: $0.id, name: $0.name, instrument: $0.instrument, role: $0.role,
                                  file: "stems/" + ($0.file as NSString).lastPathComponent, scorePart: $0.scorePart,
                                  activity: $0.activity)
                    },
                    chords: r.chords?.map { ChordSpan(beat: $0.beat, label: $0.label) })
                let main = r.parts.first(where: { $0.role == "lead" }) ?? r.parts.first(where: { $0.role == "vocals" })
                let item = try library.add(score: r.score, musicXML: r.musicxml, instrument: main?.instrument ?? "piano",
                                           kind: "split", title: r.title, split: info, link: link, stems: stems)
                phase = .finished(item.id)
            } catch is CancellationError {
                phase = .idle
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        phase = .idle
    }

    func reset() { phase = .idle }

    /// A ready-made split (synthesised trio bundled with the app) so the mixer can be tried offline.
    func addDemo(to library: Library) -> LibraryItem? {
        if let existing = library.items.first(where: { $0.sourceKind == "split" && $0.title == DemoData.trioTitle }) { return existing }
        // bundled flat as DemoTrio-split.json, DemoTrio-violin.m4a, ...
        guard let json = Bundle.main.url(forResource: "DemoTrio-split", withExtension: "json"),
              let data = try? Data(contentsOf: json),
              let r = try? JSONDecoder().decode(EngineAPI.SplitPayload.self, from: data) else { return nil }
        var stems: [String: URL] = [:]
        for p in r.parts {
            let file = (p.file as NSString).lastPathComponent
            let base = (file as NSString).deletingPathExtension, ext = (file as NSString).pathExtension
            if let u = Bundle.main.url(forResource: "DemoTrio-" + base, withExtension: ext) { stems[file] = u }
        }
        let info = SplitInfo(bpm: r.bpm, key: r.key, duration: r.duration, offset: r.offset ?? 0,
                             parts: r.parts.map {
                                 SplitPart(id: $0.id, name: $0.name, instrument: $0.instrument, role: $0.role,
                                           file: "stems/" + ($0.file as NSString).lastPathComponent, scorePart: $0.scorePart,
                                           activity: $0.activity)
                             },
                             chords: r.chords?.map { ChordSpan(beat: $0.beat, label: $0.label) })
        return try? library.add(score: r.score, musicXML: r.musicxml, instrument: "violin", kind: "split",
                                title: DemoData.trioTitle, split: info, stems: stems)
    }

    static func stageText(_ stage: String) -> LocalizedStringKey {
        switch stage {
        case "queued": return "Waiting for the server…"
        case "loading": return "Reading the recording…"
        case "vocals": return "Separating the voice…"
        case "drums": return "Separating the drums…"
        case "bass": return "Separating the bass…"
        case "lead": return "Finding the melody instrument…"
        case "transcribe": return "Writing the sheet music…"
        case "chords": return "Working out the chords…"
        case "encode": return "Preparing practice tracks…"
        case "downloading": return "Downloading the parts…"
        default: return "Working…"
        }
    }
}
