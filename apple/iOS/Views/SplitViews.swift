import PhotosUI
import PracticeCore
import SwiftUI
import UniformTypeIdentifiers

/// A video picked from Photos (a performance filmed on the phone) copied somewhere we can read it.
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let dst = FileManager.default.temporaryDirectory.appendingPathComponent("Video \(UUID().uuidString.prefix(6)).\(ext)")
            try FileManager.default.copyItem(at: received.file, to: dst)
            return PickedMovie(url: dst)
        }
    }
}

// MARK: - Band Split tab

struct SplitHomeView: View {
    @EnvironmentObject var library: Library
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var router: Router
    @EnvironmentObject var store: Store
    @EnvironmentObject var splits: SplitCenter
    @StateObject private var recorder = Recorder()
    @State private var picking = false
    @State private var showVideos = false
    @State private var videoItem: PhotosPickerItem?
    @State private var pendingFile: URL?
    @State private var link: SongLink?
    @State private var showRecorder = false
    @State private var error: String?

    private var splitItems: [LibraryItem] { library.items.filter { $0.isSplit } }

    var body: some View {
        NavigationStack(path: $router.splitPath) {
            List {
                Section { intro }
                if splits.phase != .idle {
                    Section("Now Splitting") { SplitProgressRow() }
                }
                Section {
                    if splitItems.isEmpty {
                        Button {
                            if let item = splits.addDemo(to: library) { router.splitPath = [item] }
                        } label: {
                            Label("Try the Demo Trio", systemImage: "play.circle")
                        }
                    }
                    ForEach(splitItems) { item in
                        NavigationLink(value: item) { splitRow(item) }
                    }
                    .onDelete { idx in idx.map { splitItems[$0] }.forEach(library.delete) }
                } header: {
                    Text("Your Splits")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Band Split")
            .navigationDestination(for: LibraryItem.self) { item in MixerView(item: item) }
            .fileImporter(isPresented: $picking, allowedContentTypes: Importer.recordingTypes) { result in
                if case .success(let url) = result { pendingFile = try? Importer.temporaryCopy(of: url) }
            }
            .photosPicker(isPresented: $showVideos, selection: $videoItem, matching: .videos)
            .onChange(of: videoItem) { _, item in
                guard let item else { return }
                videoItem = nil
                Task {
                    if let movie = try? await item.loadTransferable(type: PickedMovie.self) { pendingFile = movie.url }
                }
            }
            .sheet(item: Binding(get: { pendingFile.map(PendingFile.init) }, set: { if $0 == nil { pendingFile = nil } })) { p in
                WhoIsPlayingView(fileName: p.url.deletingPathExtension().lastPathComponent, link: link) { instruments, title in
                    start(p.url, instruments: instruments, title: title)
                }
            }
            .sheet(isPresented: $showRecorder) {
                RecordSheet(recorder: recorder, link: link) { url in
                    showRecorder = false
                    pendingFile = url
                }
            }
            .onAppear(perform: takeHandOff)
            .onChange(of: router.pendingSplitFile) { _, _ in takeHandOff() }
            .onChange(of: router.pendingSplitLink) { _, _ in takeHandOff() }
            .onChange(of: splits.phase) { _, phase in
                if case .finished(let id) = phase, let item = library.item(id: id) {
                    router.splitPath = [item]
                    splits.reset()
                }
            }
            .alert("Can't Split", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: {
                Text(error ?? "")
            }
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                IconBadge(symbol: "slider.vertical.3", color: .purple, size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Split a recording into parts").font(.headline)
                    Text("Voice, violin, piano and more each get their own track and sheet music.")
                        .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: 10) {
                bigButton("Audio File", "waveform") { picking = true }
                bigButton("Video", "video") { showVideos = true }
                bigButton("Record", "record.circle") { link = nil; showRecorder = true }
            }
            if !store.isPlus {
                HStack(spacing: 6) {
                    PlusBadge()
                    Group {
                        if PlusFeature.bandSplit.remaining > 0 { Text("Your first split is free.") } else { Text("Band Split is part of Haptune Plus.") }
                    }
                    .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 6)
    }

    private func bigButton(_ title: LocalizedStringKey, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: symbol).font(.title2)
                Text(title).font(.footnote.weight(.semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 64)
            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(splits.isBusy)
    }

    private func splitRow(_ item: LibraryItem) -> some View {
        HStack(spacing: 12) {
            IconBadge(symbol: "slider.vertical.3", color: .purple, size: 38)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title).font(.body.weight(.medium)).lineLimit(1)
                HStack(spacing: 4) {
                    ForEach(item.split?.parts ?? []) { p in
                        Circle().fill(InstrumentStyle.color(forRole: p.role)).frame(width: 8, height: 8)
                    }
                    Text(item.split.map { $0.parts.map(\.name).joined(separator: " · ") } ?? "")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
    }

    private func takeHandOff() {
        if let f = router.pendingSplitFile {
            router.pendingSplitFile = nil
            pendingFile = f
        }
        if let l = router.pendingSplitLink {
            router.pendingSplitLink = nil
            link = l
            showRecorder = true
        }
    }

    private func start(_ url: URL, instruments: [String], title: String) {
        pendingFile = nil
        guard let api = settings.api else {
            error = String(localized: "Band Split runs on your Haptune server. Add its address in Settings > Analysis Server.")
            return
        }
        router.gate(.bandSplit, store: store) {
            splits.start(file: url, instruments: instruments, title: title, api: api, library: library, link: link)
        }
    }
}

private struct PendingFile: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// Upload / separation progress, with Cancel.
struct SplitProgressRow: View {
    @EnvironmentObject var splits: SplitCenter

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(splits.sourceName).font(.headline).lineLimit(1)
            switch splits.phase {
            case .uploading:
                ProgressView { Text("Uploading…") }
            case .working(let stage, let progress):
                ProgressView(value: progress) { Text(SplitCenter.stageText(stage)) }
            case .failed(let message):
                Label(message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange).font(.subheadline)
            case .finished:
                Label("Done", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            case .idle:
                EmptyView()
            }
            HStack {
                Spacer()
                if splits.isBusy {
                    Button("Cancel", role: .destructive) { splits.cancel() }
                } else {
                    Button("Dismiss") { splits.reset() }
                }
            }
            .font(.subheadline)
        }
        .padding(.vertical, 4)
    }
}

/// "Who's playing?" - the instruments decide which separated sounds become which parts.
struct WhoIsPlayingView: View {
    let fileName: String
    let link: SongLink?
    var onStart: ([String], String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<String> = ["voice", "keyboard"]
    @State private var title = ""

    private struct Choice: Identifiable {
        let id: String
        let name: String
        let symbol: String
    }

    private var choices: [Choice] {
        [Choice(id: "voice", name: String(localized: "Voice"), symbol: "music.mic"),
         Choice(id: "violin", name: String(localized: "Violin"), symbol: "music.quarternote.3"),
         Choice(id: "keyboard", name: String(localized: "Keyboard / Piano"), symbol: "pianokeys"),
         Choice(id: "guitar", name: String(localized: "Guitar"), symbol: "guitars"),
         Choice(id: "bass_guitar", name: String(localized: "Bass"), symbol: "waveform"),
         Choice(id: "percussion", name: String(localized: "Drums"), symbol: "metronome"),
         Choice(id: "flute", name: String(localized: "Flute"), symbol: "music.note"),
         Choice(id: "erhu", name: String(localized: "Erhu"), symbol: "music.quarternote.3"),
         Choice(id: "cello", name: String(localized: "Cello"), symbol: "music.quarternote.3"),
         Choice(id: "alto_sax", name: String(localized: "Saxophone"), symbol: "music.note"),
         Choice(id: "dizi", name: String(localized: "Dizi"), symbol: "music.note"),
         Choice(id: "guzheng", name: String(localized: "Guzheng"), symbol: "guitars")]
    }

    private static let melodic: Set<String> = ["violin", "flute", "erhu", "cello", "alto_sax", "dizi"]

    var body: some View {
        NavigationStack {
            Form {
                Section("Title") {
                    TextField("Song title", text: $title)
                }
                Section {
                    FlowLayout(spacing: 8) {
                        ForEach(choices) { c in
                            ChoiceChip(title: c.name, symbol: c.symbol, selected: selected.contains(c.id)) { toggle(c.id) }
                        }
                    }
                    .padding(.vertical, 6)
                } header: {
                    Text("Who's playing?")
                } footer: {
                    Text("Choose one melody instrument (like violin or flute). Haptune finds its line inside the band.")
                }
                Section {
                    Label("Your recording is uploaded to your Haptune server, split, and deleted after 24 hours.", systemImage: "lock.shield")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Band Split")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Split") {
                        let t = title.trimmingCharacters(in: .whitespaces)
                        onStart(choices.map(\.id).filter { selected.contains($0) }, t.isEmpty ? fileName : t)
                        dismiss()
                    }
                    .disabled(selected.isEmpty)
                }
            }
            .onAppear { if title.isEmpty { title = link?.title ?? fileName } }
        }
        .presentationDetents([.medium, .large])
    }

    private func toggle(_ id: String) {
        if selected.contains(id) {
            selected.remove(id)
        } else {
            if Self.melodic.contains(id) { selected.subtract(Self.melodic) }     // one melody line per split
            selected.insert(id)
        }
    }
}

/// Records a band or a song playing on another speaker.
struct RecordSheet: View {
    @ObservedObject var recorder: Recorder
    let link: SongLink?
    var onDone: (URL) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var denied = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                if let link {
                    VStack(spacing: 4) {
                        Text(link.title).font(.headline)
                        if !link.artist.isEmpty { Text(link.artist).foregroundStyle(.secondary) }
                        Text("Play it in \(link.service) on another speaker, then tap Record.")
                            .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                }
                Spacer(minLength: 0)
                Text(recorder.elapsed.clock)
                    .font(.system(size: 56, weight: .light, design: .rounded))
                    .monospacedDigit()
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color(uiColor: .tertiarySystemFill))
                        Capsule().fill(Color.red.gradient).frame(width: geo.size.width * recorder.level)
                    }
                }
                .frame(height: 8)
                .padding(.horizontal, 40)
                .accessibilityHidden(true)
                Button {
                    if recorder.isRecording {
                        if let url = recorder.stop() { onDone(url) }
                    } else {
                        Task { denied = !(await recorder.start()) }
                    }
                } label: {
                    ZStack {
                        Circle().stroke(Color.primary.opacity(0.25), lineWidth: 4).frame(width: 84, height: 84)
                        if recorder.isRecording {
                            RoundedRectangle(cornerRadius: 6).fill(Color.red).frame(width: 32, height: 32)
                        } else {
                            Circle().fill(Color.red).frame(width: 68, height: 68)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(recorder.isRecording ? Text("Stop Recording") : Text("Record"))
                Group {
                    if recorder.isRecording { Text("Recording… tap to stop") } else { Text("30 seconds or more works best. Keep the phone close to the music.") }
                }
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                if denied {
                    Text("Haptune needs the microphone. Turn it on in Settings > Privacy & Security > Microphone.")
                        .font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                }
                Spacer(minLength: 0)
            }
            .padding(24)
            .navigationTitle("Record")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { recorder.stop(); dismiss() }
                }
            }
        }
    }
}

// MARK: - Mixer

/// One band split: play the parts together, mute / solo / slow down, practise any part.
struct MixerView: View {
    let item: LibraryItem
    @EnvironmentObject var library: Library
    @StateObject private var player = StemPlayer()
    @State private var speed = 1.0
    @State private var score: PracticeScore?

    private var parts: [SplitPart] { item.split?.parts ?? [] }

    var body: some View {
        List {
            Section { transport }
            Section {
                ForEach(parts) { part in partRow(part) }
            } header: {
                Text("Parts")
            } footer: {
                Text("Solo a part to hear it alone. Mute yours and play along with the rest.")
            }
            if let chords = item.split?.chords, !chords.isEmpty, let score {
                Section("Chords") { ChordChart(chords: chords, score: score) }
            }
            Section {
                ShareLink(item: library.musicXMLURL(for: item)) {
                    Label("Share Sheet Music (MusicXML)", systemImage: "square.and.arrow.up")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            score = library.score(for: item)
            if !player.isLoaded { player.load(parts.map { (id: $0.id, url: library.stemURL($0, of: item)) }) }
        }
        .onDisappear { player.pause() }
    }

    private var transport: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                if let key = item.split?.key { chip(key, "music.note") }
                if let bpm = item.split?.bpm { chip("\(Int(bpm.rounded())) BPM", "metronome") }
                chip((item.split?.duration ?? player.duration).clock, "clock")
            }
            HStack(spacing: 14) {
                Button { player.toggle() } label: {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 54, height: 54)
                        .background(Circle().fill(Color.accentColor))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(player.isPlaying ? Text("Pause") : Text("Play"))
                VStack(spacing: 2) {
                    Slider(value: Binding(get: { player.position }, set: { player.seek(to: $0) }),
                           in: 0...max(1, player.duration))
                    HStack {
                        Text(player.position.clock)
                        Spacer()
                        Text(player.duration.clock)
                    }
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            Picker("Speed", selection: $speed) {
                ForEach([1.0, 0.9, 0.8, 0.7, 0.6, 0.5], id: \.self) { s in Text(verbatim: "\(Int(s * 100))%").tag(s) }
            }
            .pickerStyle(.segmented)
            .onChange(of: speed) { _, s in player.rate = Float(s) }
        }
        .padding(.vertical, 4)
    }

    private func chip(_ text: String, _ symbol: String) -> some View {
        Label(text, systemImage: symbol)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
    }

    private func partRow(_ part: SplitPart) -> some View {
        let color = InstrumentStyle.color(forRole: part.role)
        let muted = player.muted.contains(part.id)
        let soloed = player.solo == part.id
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                IconBadge(symbol: InstrumentStyle.symbol(forRole: part.role, instrument: part.instrument), color: color, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(part.name).font(.body.weight(.semibold))
                    Text(InstrumentLibrary.profile(part.instrument).name).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    if muted { player.muted.remove(part.id) } else { player.muted.insert(part.id) }
                } label: {
                    Text(verbatim: "M").font(.subheadline.weight(.bold)).frame(width: 32, height: 32)
                        .foregroundStyle(muted ? Color.white : Color.primary)
                        .background(muted ? Color.gray : Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(muted ? Text("Unmute \(part.name)") : Text("Mute \(part.name)"))
                Button {
                    player.solo = soloed ? nil : part.id
                } label: {
                    Text(verbatim: "S").font(.subheadline.weight(.bold)).frame(width: 32, height: 32)
                        .foregroundStyle(soloed ? Color.white : Color.primary)
                        .background(soloed ? color : Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(soloed ? Text("Stop soloing \(part.name)") : Text("Solo \(part.name)"))
            }
            ActivityStrip(activity: part.activity, color: color,
                          progress: player.duration > 0 ? player.position / player.duration : nil)
                .frame(height: 26)
                .opacity((player.solo != nil && !soloed) || muted ? 0.35 : 1)
            HStack(spacing: 10) {
                Image(systemName: "speaker.fill").font(.caption).foregroundStyle(.secondary)
                Slider(value: Binding(get: { Double(player.volumes[part.id] ?? 1) },
                                      set: { player.volumes[part.id] = Float($0) }), in: 0...1)
                    .tint(color)
                if let sp = part.scorePart, let full = score {
                    let partScore = full.selectingParts([sp])
                    NavigationLink {
                        PracticeView(item: item, score: partScore, musicXML: MusicXMLWriter.write(partScore), part: part)
                    } label: {
                        Text("Practise").font(.subheadline.weight(.semibold))
                    }
                    .fixedSize()
                }
            }
        }
        .padding(.vertical, 4)
    }
}

/// Bars in rows of four with the chord symbols that start in each bar.
struct ChordChart: View {
    let chords: [ChordSpan]
    let score: PracticeScore

    var body: some View {
        let perBar = Double(score.measures.first?.timeSignature.first ?? 4)
        let bars = max(1, score.measures.count)
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 4), spacing: 0) {
            ForEach(0..<bars, id: \.self) { b in
                let here = chords.filter { Int($0.beat / perBar) == b }.map(\.label)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: "\(b + 1)").font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
                    Text(verbatim: here.isEmpty ? "%" : here.joined(separator: "  "))
                        .font(.system(.title3, design: .rounded).weight(here.isEmpty ? .regular : .bold))
                        .foregroundStyle(here.isEmpty ? Color.secondary : Color.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .topLeading)
                .padding(6)
                .overlay(alignment: .trailing) { Rectangle().fill(Color(uiColor: .separator)).frame(width: 0.5) }
                .overlay(alignment: .bottom) { Rectangle().fill(Color(uiColor: .separator)).frame(height: 0.5) }
            }
        }
    }
}
