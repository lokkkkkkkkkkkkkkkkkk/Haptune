import PracticeCore
import SwiftUI

/// Type a song name or paste a YouTube link: Hapi searches the web for real sheet music (MusicXML, MIDI or
/// PDF), shows what it found, and adds the one you pick to the Library. PDFs are read by the AI reader.
struct FindSongView: View {
    @EnvironmentObject var library: Library
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var router: Router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var text = ""
    @State private var searching = false
    @State private var result: EngineAPI.FindPayload?
    @State private var adding: String?
    @State private var readValue: Double?
    @State private var readText = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HapiSays(text: searching ? "Searching the web for sheet music… this takes about a minute."
                                             : "Type a song name or paste a YouTube link. I'll look for sheet music you can play along with.",
                             mood: searching ? .think : .happy)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                }
                Section {
                    TextField("Song name or YouTube link", text: $text)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .onSubmit { Task { await search() } }
                    PasteButton(payloadType: String.self) { strings in
                        if let s = strings.first { text = s }
                    }
                } footer: {
                    Text("For example “Canon in D”, “Twinkle Twinkle piano easy”, or a link from YouTube, Spotify or Apple Music.")
                }

                if searching {
                    Section { HStack(spacing: 12) { ProgressView(); Text("Hapi is searching…").foregroundStyle(.secondary) } }
                }

                if let r = result {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(r.song.title).font(.headline)
                            if !r.song.artist.isEmpty { Text(r.song.artist).foregroundStyle(.secondary) }
                            if let advice = r.advice, !advice.isEmpty {
                                Text(advice).font(.footnote).foregroundStyle(.secondary).padding(.top, 2)
                            }
                        }
                        if let yt = r.youtubeID, let u = URL(string: "https://www.youtube.com/watch?v=\(yt)") {
                            Button { openURL(u) } label: { Label("Listen on YouTube", systemImage: "play.rectangle.fill") }
                                .tint(.red)
                        }
                    }
                    Section {
                        if r.candidates.isEmpty {
                            Text("Nothing free to download turned up. Try another spelling, or add the composer's name.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(r.candidates) { c in candidateRow(c) }
                    } header: {
                        Text("Sheet Music Found")
                    } footer: {
                        if r.song.copyrighted == true {
                            Text("This song is still under copyright, so only free arrangements and the publishers' own pages are shown.")
                        }
                    }
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .scrollContentBackground(.hidden)
            .background { HaptuneBackground() }
            .navigationTitle("Find a Song")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Find") { Task { await search() } }
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || searching)
                }
            }
            .overlay {
                if adding != nil {
                    VStack(spacing: 12) {
                        HapiMascot(size: 70, mood: .think)
                        if let v = readValue {
                            ProgressView(value: v) { Text("Reading the music…") } currentValueLabel: { Text(readText) }
                        } else {
                            ProgressView("Adding to your Library…")
                        }
                    }
                    .frame(maxWidth: 300)
                    .padding(20)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
            }
        }
    }

    private func candidateRow(_ c: EngineAPI.FindPayload.Candidate) -> some View {
        HStack(spacing: 12) {
            IconBadge(symbol: symbol(c.format), color: color(c.format), size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(c.title).font(.body.weight(.medium)).lineLimit(2)
                Text(details(c)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 6)
            if c.canImport {
                Button("Add") { Task { await add(c) } }
                    .buttonStyle(.borderedProminent)
                    .tint(.purple)
                    .disabled(adding != nil)
            } else if let u = URL(string: c.pageURL) {
                Button("Open") { openURL(u) }.buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 2)
    }

    private func details(_ c: EngineAPI.FindPayload.Candidate) -> String {
        var parts: [String] = [c.format.uppercased()]
        for x in [c.arrangement, c.source, c.license] {
            if let x, !x.isEmpty { parts.append(x) }
        }
        if let n = c.pages, n > 0 { parts.append(String(localized: "\(n) pages")) }
        return parts.joined(separator: " · ")
    }

    private func symbol(_ format: String) -> String {
        switch format {
        case "musicxml", "mxl": return "music.note.list"
        case "midi": return "pianokeys"
        case "pdf": return "doc.richtext"
        case "abc": return "textformat.abc"
        default: return "safari"
        }
    }

    private func color(_ format: String) -> Color {
        switch format {
        case "musicxml", "mxl": return .purple
        case "midi": return .blue
        case "pdf": return .orange
        case "abc": return .teal
        default: return .gray
        }
    }

    private func search() async {
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !searching else { return }
        guard let api = settings.api else { error = ImportError.needsServer.localizedDescription; return }
        searching = true
        error = nil
        result = nil
        defer { searching = false }
        let isLink = q.contains("http://") || q.contains("https://")
        do {
            result = try await api.findMusic(query: isLink ? "" : q, link: isLink ? q : "", instrument: settings.instrumentKey)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func add(_ c: EngineAPI.FindPayload.Candidate) async {
        guard let api = settings.api, let fileURL = c.fileURL else { return }
        adding = c.id
        readValue = nil
        readText = ""
        error = nil
        defer { adding = nil; readValue = nil }
        do {
            let file = try await api.fetchMusicFile(fileURL)
            var importer = Importer(api: api)
            importer.progress = { value, message in
                readValue = value
                readText = message
            }
            let r = try await importer.importFile(file, instrument: settings.instrument)
            let inst = r.score.parts.first.map { $0.instrument.isEmpty ? settings.instrumentKey : $0.instrument } ?? settings.instrumentKey
            let title = r.score.title.isEmpty || r.score.title == file.deletingPathExtension().lastPathComponent ? result?.song.title : nil
            let item = try library.add(score: r.score, musicXML: r.musicXML, instrument: inst, kind: "found", title: title)
            dismiss()
            router.open(item)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
