import Foundation
import PracticeCore

/// A song found from an Apple Music / Spotify / YouTube link (metadata only; streaming audio stays in its app).
struct SongLink: Codable, Hashable {
    var service: String
    var url: String
    var title: String
    var artist: String
    var artworkURL: String?
}

/// One instrument line of a band split.
struct SplitPart: Codable, Hashable, Identifiable {
    var id: String              // vocals | lead | keys | bass | drums | other
    var name: String            // shown to the user: "Voice", "Violin", "Keyboard"
    var instrument: String      // instrument profile key
    var role: String
    var file: String            // stem audio, relative to the piece folder ("stems/vocals.m4a")
    var scorePart: String?      // part id inside score.json (nil = no notation, e.g. drums)
    var activity: [Double]      // 0...1 loudness per second, for the timeline
}

struct ChordSpan: Codable, Hashable {
    var beat: Double
    var label: String
}

struct SplitInfo: Codable, Hashable {
    var bpm: Double?
    var key: String?
    var duration: Double
    var offset: Double          // seconds from the start of the audio to beat 0 of the score
    var parts: [SplitPart]
    var chords: [ChordSpan]?
}

struct LibraryItem: Codable, Identifiable, Hashable {
    var id = UUID()
    var title: String
    var composer = ""
    var instrument: String
    var addedAt = Date()
    var lastPracticed: Date?
    var bestScore: Int?
    var sourceKind: String          // musicxml | midi | jianpu | pdf | photo | recording | exercise | json | split
    var favorite = false
    var lastBar: String?
    var split: SplitInfo?
    var link: SongLink?

    init(title: String, instrument: String, sourceKind: String) {
        self.title = title
        self.instrument = instrument
        self.sourceKind = sourceKind
    }

    enum CodingKeys: String, CodingKey {
        case id, title, composer, instrument, addedAt, lastPracticed, bestScore, sourceKind, favorite, lastBar, split, link
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        composer = try c.decodeIfPresent(String.self, forKey: .composer) ?? ""
        instrument = try c.decodeIfPresent(String.self, forKey: .instrument) ?? "piano"
        addedAt = try c.decodeIfPresent(Date.self, forKey: .addedAt) ?? Date()
        lastPracticed = try c.decodeIfPresent(Date.self, forKey: .lastPracticed)
        bestScore = try c.decodeIfPresent(Int.self, forKey: .bestScore)
        sourceKind = try c.decodeIfPresent(String.self, forKey: .sourceKind) ?? "musicxml"
        favorite = try c.decodeIfPresent(Bool.self, forKey: .favorite) ?? false
        lastBar = try c.decodeIfPresent(String.self, forKey: .lastBar)
        split = try c.decodeIfPresent(SplitInfo.self, forKey: .split)
        link = try c.decodeIfPresent(SongLink.self, forKey: .link)
    }

    var isSplit: Bool { split != nil }
    var sortDate: Date { lastPracticed ?? addedAt }
}

/// One finished take, for the Summary screen.
struct PracticeRecord: Codable, Identifiable, Hashable {
    var id = UUID()
    var itemID: UUID?
    var title: String
    var instrument: String
    var date: Date
    var seconds: Double
    var correct: Int
    var wrong: Int
    var missed: Int
    var total: Int
    var outOfTune: Int
    var timing: Int
    var mode: String
    var tempoPercent: Int

    var accuracy: Double { total > 0 ? Double(correct) / Double(total) : 0 }
    var inTune: Double { total > 0 ? max(0, 1 - Double(outOfTune) / Double(total)) : 1 }
}

/// The user's pieces and practice history, stored as small files so iCloud Drive can sync them
/// between iPhone, iPad and Mac without one shared index file that could conflict:
///
///     Library/Pieces/<id>/item.json, score.json, score.musicxml, stems/*.m4a
///     Library/History/<record id>.json
@MainActor
final class Library: ObservableObject {
    enum Location: Equatable { case local, iCloud }

    @Published private(set) var items: [LibraryItem] = []
    @Published private(set) var history: [PracticeRecord] = []
    @Published private(set) var location: Location = .local
    private(set) var root: URL
    private var query: NSMetadataQuery?
    private var observers: [NSObjectProtocol] = []

    nonisolated static var localRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Library", isDirectory: true)
    }

    /// nil when iCloud Drive is off, the user is signed out, or the build has no iCloud capability.
    nonisolated static func cloudRoot() -> URL? {
        FileManager.default.url(forUbiquityContainerIdentifier: nil)?
            .appendingPathComponent("Documents", isDirectory: true)
            .appendingPathComponent("Library", isDirectory: true)
    }

    init() {
        root = Self.localRoot
        ensureFolders()
        reload()
    }

    private var piecesDir: URL { root.appendingPathComponent("Pieces", isDirectory: true) }
    private var historyDir: URL { root.appendingPathComponent("History", isDirectory: true) }

    private func ensureFolders() {
        try? FileManager.default.createDirectory(at: piecesDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: historyDir, withIntermediateDirectories: true)
    }

    func folder(for item: LibraryItem) -> URL { piecesDir.appendingPathComponent(item.id.uuidString, isDirectory: true) }

    // MARK: loading

    func reload() {
        let fm = FileManager.default
        var list: [LibraryItem] = []
        let dirs = (try? fm.contentsOfDirectory(at: piecesDir, includingPropertiesForKeys: nil)) ?? []
        for d in dirs {
            let f = d.appendingPathComponent("item.json")
            if let data = try? Data(contentsOf: f), let it = try? JSONDecoder().decode(LibraryItem.self, from: data) {
                list.append(it)
            } else {
                requestDownload(in: d)
            }
        }
        items = list.sorted { $0.sortDate > $1.sortDate }
        var recs: [PracticeRecord] = []
        for f in (try? fm.contentsOfDirectory(at: historyDir, includingPropertiesForKeys: nil)) ?? [] where f.pathExtension == "json" {
            if let data = try? Data(contentsOf: f), let r = try? JSONDecoder().decode(PracticeRecord.self, from: data) { recs.append(r) }
        }
        history = recs.sorted { $0.date < $1.date }
    }

    /// iCloud keeps not-yet-downloaded files as ".name.icloud" placeholders.
    private func requestDownload(in dir: URL) {
        guard location == .iCloud else { return }
        for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] {
            let name = f.lastPathComponent
            if name.hasPrefix("."), name.hasSuffix(".icloud") {
                let real = dir.appendingPathComponent(String(name.dropFirst().dropLast(".icloud".count)))
                try? FileManager.default.startDownloadingUbiquitousItem(at: real)
            }
        }
    }

    // MARK: pieces

    @discardableResult
    func add(score: PracticeScore, musicXML: String?, instrument: String, kind: String, title: String? = nil,
             split: SplitInfo? = nil, link: SongLink? = nil, stems: [String: URL] = [:]) throws -> LibraryItem {
        let name = (title ?? score.title).trimmingCharacters(in: .whitespacesAndNewlines)
        var item = LibraryItem(title: name.isEmpty ? String(localized: "Untitled") : name, instrument: instrument, sourceKind: kind)
        item.composer = score.composer
        item.split = split
        item.link = link
        let d = folder(for: item)
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        try score.encoded().write(to: d.appendingPathComponent("score.json"), options: .atomic)
        let xml = musicXML ?? MusicXMLWriter.write(score)
        try Data(xml.utf8).write(to: d.appendingPathComponent("score.musicxml"), options: .atomic)
        if !stems.isEmpty {
            let sd = d.appendingPathComponent("stems", isDirectory: true)
            try FileManager.default.createDirectory(at: sd, withIntermediateDirectories: true)
            for (name, src) in stems {
                let dst = sd.appendingPathComponent(name)
                try? FileManager.default.removeItem(at: dst)
                try FileManager.default.copyItem(at: src, to: dst)
            }
        }
        try write(item)
        items.insert(item, at: 0)
        return item
    }

    private func write(_ item: LibraryItem) throws {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        try e.encode(item).write(to: folder(for: item).appendingPathComponent("item.json"), options: .atomic)
    }

    func score(for item: LibraryItem) -> PracticeScore? {
        (try? Data(contentsOf: folder(for: item).appendingPathComponent("score.json"))).flatMap { try? PracticeScore.decode($0) }
    }

    func musicXML(for item: LibraryItem) -> String? {
        (try? Data(contentsOf: folder(for: item).appendingPathComponent("score.musicxml"))).map { String(decoding: $0, as: UTF8.self) }
    }

    func musicXMLURL(for item: LibraryItem) -> URL { folder(for: item).appendingPathComponent("score.musicxml") }

    func stemURL(_ part: SplitPart, of item: LibraryItem) -> URL { folder(for: item).appendingPathComponent(part.file) }

    /// Takes are large and personal: kept in Caches, never synced.
    func takeURL(for item: LibraryItem) -> URL {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Takes", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d.appendingPathComponent("\(item.id.uuidString).caf")
    }

    func update(_ item: LibraryItem) {
        guard let i = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[i] = item
        try? write(item)
        items.sort { $0.sortDate > $1.sortDate }
    }

    func toggleFavorite(_ item: LibraryItem) {
        var it = item
        it.favorite.toggle()
        update(it)
    }

    func rename(_ item: LibraryItem, to title: String) {
        var it = item
        it.title = title
        update(it)
    }

    func delete(_ item: LibraryItem) {
        try? FileManager.default.removeItem(at: folder(for: item))
        try? FileManager.default.removeItem(at: takeURL(for: item))
        items.removeAll { $0.id == item.id }
    }

    func item(id: UUID?) -> LibraryItem? { items.first { $0.id == id } }

    // MARK: history

    func record(_ r: PracticeRecord) {
        history.append(r)
        if let data = try? JSONEncoder().encode(r) {
            try? data.write(to: historyDir.appendingPathComponent("\(r.id.uuidString).json"), options: .atomic)
        }
    }

    // MARK: iCloud

    /// Switches storage between this device and iCloud Drive. Returns false if iCloud is unavailable.
    @discardableResult
    func useCloud(_ enabled: Bool) async -> Bool {
        if enabled {
            let cloud = await Task.detached { Library.cloudRoot() }.value
            guard let cloud else {
                stopMonitoring()
                if location != .local { root = Self.localRoot; location = .local; ensureFolders(); reload() }
                return false
            }
            if location == .iCloud && root == cloud { return true }
            let local = Self.localRoot
            _ = await Task.detached { Library.merge(from: local, into: cloud) }.value
            root = cloud
            location = .iCloud
            ensureFolders()
            reload()
            startMonitoring()
            return true
        } else {
            if location == .iCloud {
                let from = root, local = Self.localRoot
                _ = await Task.detached { Library.merge(from: from, into: local) }.value
            }
            stopMonitoring()
            root = Self.localRoot
            location = .local
            ensureFolders()
            reload()
            return true
        }
    }

    /// Copies pieces and history that `dst` does not have yet. Returns the number of pieces copied.
    nonisolated static func merge(from src: URL, into dst: URL) -> Int {
        let fm = FileManager.default
        var added = 0
        for sub in ["Pieces", "History"] {
            let s = src.appendingPathComponent(sub, isDirectory: true)
            let d = dst.appendingPathComponent(sub, isDirectory: true)
            try? fm.createDirectory(at: d, withIntermediateDirectories: true)
            for f in (try? fm.contentsOfDirectory(at: s, includingPropertiesForKeys: nil)) ?? [] {
                let target = d.appendingPathComponent(f.lastPathComponent)
                if fm.fileExists(atPath: target.path) { continue }
                if (try? fm.copyItem(at: f, to: target)) != nil, sub == "Pieces" { added += 1 }
            }
        }
        return added
    }

    private func startMonitoring() {
        stopMonitoring()
        let q = NSMetadataQuery()
        q.searchScopes = [NSMetadataQueryUbiquitousDocumentsScope]
        q.predicate = NSPredicate(format: "%K LIKE '*'", NSMetadataItemFSNameKey)
        let center = NotificationCenter.default
        for name in [Notification.Name.NSMetadataQueryDidFinishGathering, .NSMetadataQueryDidUpdate] {
            observers.append(center.addObserver(forName: name, object: q, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.cloudChanged() }
            })
        }
        q.start()
        query = q
    }

    private func stopMonitoring() {
        query?.stop()
        query = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
    }

    private func cloudChanged() {
        guard let q = query else { return }
        q.disableUpdates()
        for case let item as NSMetadataItem in q.results {
            let status = item.value(forAttribute: NSMetadataUbiquitousItemDownloadingStatusKey) as? String
            if status != NSMetadataUbiquitousItemDownloadingStatusCurrent, let url = item.value(forAttribute: NSMetadataItemURLKey) as? URL {
                try? FileManager.default.startDownloadingUbiquitousItem(at: url)
            }
        }
        q.enableUpdates()
        reload()
    }

    // MARK: backup (works with Files, Google Drive, Dropbox, OneDrive)

    func makeBackup() throws -> URL {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("Haptune Backup \(f.string(from: Date())).zip")
        try FolderArchive.zip(directory: root, to: url)
        return url
    }

    /// Adds the pieces and history from a backup that are not in the library yet. Returns pieces added.
    func restoreBackup(from url: URL) throws -> Int {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        try FolderArchive.unzip(url, to: tmp)
        // the archive holds Pieces/ and History/ directly, or inside one top folder
        var base = tmp
        if !FileManager.default.fileExists(atPath: tmp.appendingPathComponent("Pieces").path),
           let sub = (try? FileManager.default.contentsOfDirectory(at: tmp, includingPropertiesForKeys: nil))?.first {
            base = sub
        }
        let added = Self.merge(from: base, into: root)
        reload()
        return added
    }
}
