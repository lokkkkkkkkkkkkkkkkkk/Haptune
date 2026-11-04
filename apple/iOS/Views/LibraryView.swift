import PhotosUI
import PracticeCore
import SwiftUI
import UniformTypeIdentifiers
#if canImport(VisionKit) && !targetEnvironment(macCatalyst)
import VisionKit
#endif

enum LibraryFilter: String, CaseIterable, Identifiable {
    case all, favorites, pieces, splits, exercises
    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .all: return "All Pieces"
        case .favorites: return "Favourites"
        case .pieces: return "Sheet Music"
        case .splits: return "Band Splits"
        case .exercises: return "Scales & Exercises"
        }
    }

    var symbol: String {
        switch self {
        case .all: return "music.note.list"
        case .favorites: return "star"
        case .pieces: return "doc.richtext"
        case .splits: return "slider.vertical.3"
        case .exercises: return "stairs"
        }
    }

    func includes(_ item: LibraryItem) -> Bool {
        switch self {
        case .all: return true
        case .favorites: return item.favorite
        case .pieces: return item.sourceKind != "split" && item.sourceKind != "exercise"
        case .splits: return item.sourceKind == "split"
        case .exercises: return item.sourceKind == "exercise"
        }
    }
}

struct LibraryView: View {
    @EnvironmentObject var library: Library
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var router: Router
    @EnvironmentObject var store: Store
    @State private var search = ""
    @State private var filter: LibraryFilter = .all
    @State private var importing = false
    @State private var busy: LocalizedStringKey?
    @State private var error: String?
    @State private var jianpuSheet = false
    @State private var linkSheet = false
    @State private var scaleSheet = false
    @State private var scanning = false
    @State private var showPhotos = false
    @State private var photoItem: PhotosPickerItem?
    @State private var pendingRecording: URL?
    @State private var renaming: LibraryItem?
    @State private var newTitle = ""

    private var filtered: [LibraryItem] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        return library.items.filter { item in
            filter.includes(item) && (q.isEmpty || item.title.lowercased().contains(q) || item.composer.lowercased().contains(q)
                                      || InstrumentLibrary.profile(item.instrument).name.lowercased().contains(q))
        }
    }

    private var recent: [LibraryItem] {
        Array(library.items.filter { $0.lastPracticed != nil }.sorted { ($0.lastPracticed ?? .distantPast) > ($1.lastPracticed ?? .distantPast) }.prefix(3))
    }

    var body: some View {
        NavigationStack(path: $router.libraryPath) {
            List {
                if library.items.isEmpty {
                    ContentUnavailableView {
                        Label("No Pieces Yet", systemImage: "music.note.list")
                    } description: {
                        Text("Import MusicXML or MIDI, scan printed music, type jianpu, or split a recording into parts.")
                    } actions: {
                        Button("Import a File") { importing = true }.buttonStyle(.borderedProminent)
                        Button("Try Samples") { DemoData.addSamplePieces(to: library, instrument: settings.instrument) }
                    }
                    .listRowBackground(Color.clear)
                } else if filtered.isEmpty {
                    ContentUnavailableView.search(text: search).listRowBackground(Color.clear)
                }
                if search.isEmpty && filter == .all && !recent.isEmpty {
                    Section("Recently Practised") {
                        ForEach(recent) { item in row(item) }
                    }
                }
                if !filtered.isEmpty {
                    Section {
                        ForEach(filtered) { item in row(item) }
                    } header: {
                        Text(filter.title)
                    } footer: {
                        Text("\(filtered.count) pieces")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $search, prompt: Text("Pieces, composers, instruments"))
            .navigationTitle("Library")
            .navigationDestination(for: LibraryItem.self) { item in PieceDestination(item: item) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { filterMenu }
                ToolbarItem(placement: .primaryAction) { addMenu }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: Importer.contentTypes) { result in
                if case .success(let url) = result { handlePicked(url) }
            }
            .photosPicker(isPresented: $showPhotos, selection: $photoItem, matching: .images)
            .onChange(of: photoItem) { _, item in
                guard let item else { return }
                photoItem = nil
                Task { await importPhoto(item) }
            }
            .sheet(isPresented: $jianpuSheet) { JianpuEntryView() }
            .sheet(isPresented: $linkSheet) { LinkImportView() }
            .sheet(isPresented: $scaleSheet) { NavigationStack { ScalesView(asSheet: true) } }
            #if canImport(VisionKit) && !targetEnvironment(macCatalyst)
            .fullScreenCover(isPresented: $scanning) {
                DocumentScanner { url in
                    scanning = false
                    if let url { Task { await importFile(url) } }
                }
                .ignoresSafeArea()
            }
            #endif
            .confirmationDialog("What's in this recording?", isPresented: Binding(get: { pendingRecording != nil },
                                                                                  set: { if !$0 { pendingRecording = nil } }),
                                titleVisibility: .visible) {
                Button("One Instrument or Voice") {
                    if let url = pendingRecording {
                        router.gate(.transcribe, store: store) { Task { await importFile(url) } }
                    }
                    pendingRecording = nil
                }
                Button("A Band or a Song (Band Split)") {
                    router.pendingSplitFile = pendingRecording
                    router.tab = .split
                    pendingRecording = nil
                }
                Button("Cancel", role: .cancel) { pendingRecording = nil }
            } message: {
                Text("Haptune can write sheet music for one instrument, or split a band recording into a part for each instrument.")
            }
            .alert("Rename Piece", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Title", text: $newTitle)
                Button("Cancel", role: .cancel) { renaming = nil }
                Button("Rename") {
                    if let it = renaming, !newTitle.trimmingCharacters(in: .whitespaces).isEmpty { library.rename(it, to: newTitle) }
                    renaming = nil
                }
            }
            .alert("Couldn't Import", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: {
                Text(error ?? "")
            }
            .overlay {
                if let busy {
                    ProgressView(busy)
                        .padding(20)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
        }
    }

    // MARK: rows

    private func row(_ item: LibraryItem) -> some View {
        NavigationLink(value: item) {
            HStack(spacing: 12) {
                IconBadge(symbol: InstrumentStyle.symbol(for: item), color: InstrumentStyle.color(for: item), size: 38)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).font(.body.weight(.medium)).lineLimit(1)
                    Text(subtitle(item)).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                if item.favorite {
                    Image(systemName: "star.fill").font(.caption).foregroundStyle(.yellow).accessibilityLabel(Text("Favourite"))
                }
                if let best = item.bestScore {
                    Text(verbatim: "\(best)%").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
        }
        .swipeActions(edge: .leading) {
            Button { library.toggleFavorite(item) } label: {
                if item.favorite { Label("Unfavourite", systemImage: "star.slash") } else { Label("Favourite", systemImage: "star") }
            }
            .tint(.yellow)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { library.delete(item) } label: { Label("Delete", systemImage: "trash") }
        }
        .contextMenu {
            Button { library.toggleFavorite(item) } label: {
                if item.favorite { Label("Unfavourite", systemImage: "star.slash") } else { Label("Favourite", systemImage: "star") }
            }
            Button { newTitle = item.title; renaming = item } label: { Label("Rename", systemImage: "pencil") }
            ShareLink(item: library.musicXMLURL(for: item)) { Label("Share MusicXML", systemImage: "square.and.arrow.up") }
            Divider()
            Button(role: .destructive) { library.delete(item) } label: { Label("Delete", systemImage: "trash") }
        }
    }

    private func subtitle(_ item: LibraryItem) -> String {
        var parts: [String] = []
        if item.isSplit, let n = item.split?.parts.count {
            parts.append(String(localized: "\(n) parts"))
        } else {
            parts.append(InstrumentLibrary.profile(item.instrument).name)
        }
        if !item.composer.isEmpty { parts.append(item.composer) }
        if let d = item.lastPracticed { parts.append(d.formatted(.relative(presentation: .named))) }
        return parts.joined(separator: " · ")
    }

    // MARK: menus

    private var filterMenu: some View {
        Menu {
            Picker("Show", selection: $filter) {
                ForEach(LibraryFilter.allCases) { f in Label(f.title, systemImage: f.symbol).tag(f) }
            }
        } label: {
            Label("Show", systemImage: filter == .all ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
    }

    private var addMenu: some View {
        Menu {
            Section {
                Button { importing = true } label: { Label("Import File", systemImage: "folder") }
                #if canImport(VisionKit) && !targetEnvironment(macCatalyst)
                if VNDocumentCameraViewController.isSupported {
                    Button { router.gate(.scan, store: store) { scanning = true } } label: {
                        Label("Scan Sheet Music", systemImage: "doc.viewfinder")
                    }
                }
                #endif
                Button { router.gate(.scan, store: store) { showPhotos = true } } label: {
                    Label("Photo of Sheet Music", systemImage: "photo.on.rectangle")
                }
            }
            Section {
                Button { router.tab = .split } label: { Label("Split a Recording", systemImage: "slider.vertical.3") }
                Button { linkSheet = true } label: { Label("From Apple Music or Spotify", systemImage: "link") }
            }
            Section {
                Button { jianpuSheet = true } label: { Label("Type Jianpu (简谱)", systemImage: "character.cursor.ibeam") }
                Button { scaleSheet = true } label: { Label("Scale or Arpeggio", systemImage: "stairs") }
            }
        } label: {
            Label("Add", systemImage: "plus")
        }
    }

    // MARK: importing

    private func handlePicked(_ url: URL) {
        switch Importer.kind(of: url) {
        case .recording:
            pendingRecording = (try? Importer.temporaryCopy(of: url)) ?? url
        case .image:
            router.gate(.scan, store: store) { Task { await importFile(url) } }
        default:
            Task { await importFile(url) }
        }
    }

    private func importPhoto(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("Sheet music \(Int(Date().timeIntervalSince1970)).jpg")
        do {
            try data.write(to: url)
            await importFile(url)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func importFile(_ url: URL) async {
        busy = Importer.kind(of: url) == .score ? "Reading the score…" : "Reading the music… this can take a minute"
        defer { busy = nil }
        do {
            let r = try await Importer(api: settings.api).importFile(url, instrument: settings.instrument)
            let inst = r.score.parts.first.map { $0.instrument.isEmpty ? settings.instrumentKey : $0.instrument } ?? settings.instrumentKey
            let item = try library.add(score: r.score, musicXML: r.musicXML, instrument: inst, kind: r.kind)
            router.libraryPath = [item]
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Opens a piece: the mixer for band splits, the practice screen for everything else.
struct PieceDestination: View {
    let item: LibraryItem
    @EnvironmentObject var library: Library

    var body: some View {
        if item.isSplit {
            MixerView(item: item)
        } else if let s = library.score(for: item) {
            PracticeView(item: item, score: s, musicXML: library.musicXML(for: item) ?? MusicXMLWriter.write(s))
        } else {
            ContentUnavailableView("Can't Open This Piece", systemImage: "exclamationmark.triangle",
                                   description: Text("If you use iCloud, it may still be downloading. Try again in a moment."))
        }
    }
}

// MARK: - Jianpu

struct JianpuEntryView: View {
    @EnvironmentObject var library: Library
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var router: Router
    @Environment(\.dismiss) private var dismiss
    @State private var text = DemoData.odeToJoy
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text).font(.system(.body, design: .monospaced)).frame(minHeight: 220)
                } footer: {
                    Text("1–7 = scale degrees, 0 = rest, - = hold a beat, _ = half the length, . = dotted, ' up an octave, , down an octave, | bar line.")
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Jianpu")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        do {
                            let s = try Jianpu.parse(text, instrument: settings.instrumentKey)
                            let item = try library.add(score: s, musicXML: MusicXMLWriter.write(s), instrument: settings.instrumentKey, kind: "jianpu")
                            dismiss()
                            router.libraryPath = [item]
                        } catch { self.error = error.localizedDescription }
                    }
                }
            }
        }
    }
}

// MARK: - Apple Music / Spotify / YouTube link

struct LinkImportView: View {
    @EnvironmentObject var router: Router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var text = ""
    @State private var song: SongLink?
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://open.spotify.com/track/…", text: $text, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    PasteButton(payloadType: String.self) { strings in
                        if let s = strings.first { text = s }
                    }
                } footer: {
                    Text("Share a song from Apple Music, Spotify or YouTube, choose Copy Link, then paste it here.")
                }
                if loading {
                    HStack { ProgressView(); Text("Looking up the song…").foregroundStyle(.secondary) }
                }
                if let song {
                    Section {
                        HStack(spacing: 14) {
                            AsyncImage(url: URL(string: song.artworkURL ?? "")) { img in
                                img.resizable().scaledToFill()
                            } placeholder: {
                                Color(uiColor: .tertiarySystemFill).overlay { Image(systemName: "music.note").foregroundStyle(.secondary) }
                            }
                            .frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(song.title).font(.headline)
                                if !song.artist.isEmpty { Text(song.artist).foregroundStyle(.secondary) }
                                Text(song.service).font(.caption).foregroundStyle(.tertiary)
                            }
                        }
                    }
                    Section {
                        Button {
                            router.pendingSplitLink = song
                            router.tab = .split
                            dismiss()
                        } label: { Label("Play It Out Loud and Record", systemImage: "record.circle") }
                        if let u = LinkImporter.sheetMusicSearchURL(for: song) {
                            Button { openURL(u) } label: { Label("Find Sheet Music on the Web", systemImage: "magnifyingglass") }
                        }
                        if let u = URL(string: song.url) {
                            Button { openURL(u) } label: { Label("Open in \(song.service)", systemImage: "arrow.up.forward.app") }
                        }
                    } footer: {
                        Text("Streaming apps don't share their audio with other apps. Play the song on another speaker and Haptune will listen, then split it into parts and write the sheet music.")
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Add from a Link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Find") { Task { await resolve() } }.disabled(text.isEmpty || loading)
                }
            }
            .onChange(of: text) { _, new in
                if new.contains("http"), song == nil, !loading { Task { await resolve() } }
            }
        }
    }

    private func resolve() async {
        loading = true
        error = nil
        defer { loading = false }
        do { song = try await LinkImporter.resolve(text) } catch { self.error = error.localizedDescription; song = nil }
    }
}

// MARK: - Document camera

#if canImport(VisionKit) && !targetEnvironment(macCatalyst)
/// The system document scanner; pages become one PDF (A4 width) for the OMR server.
struct DocumentScanner: UIViewControllerRepresentable {
    var onFinish: (URL?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let vc = VNDocumentCameraViewController()
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: VNDocumentCameraViewController, context: Context) {}

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onFinish: (URL?) -> Void
        init(onFinish: @escaping (URL?) -> Void) { self.onFinish = onFinish }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            guard scan.pageCount > 0 else { onFinish(nil); return }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("Scan \(Int(Date().timeIntervalSince1970)).pdf")
            let width: CGFloat = 595                                  // A4 in points
            let first = scan.imageOfPage(at: 0)
            let bounds = CGRect(x: 0, y: 0, width: width, height: width * first.size.height / max(1, first.size.width))
            let renderer = UIGraphicsPDFRenderer(bounds: bounds)
            do {
                try renderer.writePDF(to: url) { ctx in
                    for i in 0..<scan.pageCount {
                        let img = scan.imageOfPage(at: i)
                        let page = CGRect(x: 0, y: 0, width: width, height: width * img.size.height / max(1, img.size.width))
                        ctx.beginPage(withBounds: page, pageInfo: [:])
                        img.draw(in: page)
                    }
                }
                onFinish(url)
            } catch {
                onFinish(nil)
            }
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { onFinish(nil) }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) { onFinish(nil) }
    }
}
#endif
