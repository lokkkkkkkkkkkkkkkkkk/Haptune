import Foundation

/// Reads a shared Apple Music, Spotify or YouTube link and returns the song's title, artist and
/// artwork. Streaming services do not let other apps read their audio, so Melovyn then *listens*
/// while you play the song out loud (like Shazam) and splits that recording.
enum LinkImporter {
    enum LinkError: LocalizedError {
        case notALink, unsupported, notFound
        var errorDescription: String? {
            switch self {
            case .notALink: return String(localized: "Paste a link to a song.")
            case .unsupported: return String(localized: "Links from Apple Music, Spotify and YouTube are supported.")
            case .notFound: return String(localized: "Couldn't find that song.")
            }
        }
    }

    static func resolve(_ text: String) async throws -> SongLink {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let start = trimmed.range(of: "https://") ?? trimmed.range(of: "http://") else { throw LinkError.notALink }
        let raw = String(trimmed[start.lowerBound...]).split(whereSeparator: { $0 == " " || $0 == "\n" }).first.map(String.init) ?? ""
        guard let url = URL(string: raw), let host = url.host?.lowercased() else { throw LinkError.notALink }
        if host.contains("spotify.com") || host == "spotify.link" {
            return try await oEmbed("https://open.spotify.com/oembed?url=", url: url, service: "Spotify")
        }
        if host.contains("youtube.com") || host.contains("youtu.be") {
            return try await oEmbed("https://www.youtube.com/oembed?format=json&url=", url: url, service: "YouTube")
        }
        if host.contains("music.apple.com") || host.contains("itunes.apple.com") {
            return try await appleMusic(url)
        }
        throw LinkError.unsupported
    }

    private struct OEmbed: Decodable {
        let title: String?
        let author_name: String?
        let thumbnail_url: String?
    }

    private static func oEmbed(_ endpoint: String, url: URL, service: String) async throws -> SongLink {
        let q = url.absoluteString.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? url.absoluteString
        guard let api = URL(string: endpoint + q) else { throw LinkError.notALink }
        let (data, _) = try await URLSession.shared.data(from: api)
        guard let o = try? JSONDecoder().decode(OEmbed.self, from: data), let title = o.title, !title.isEmpty else { throw LinkError.notFound }
        return SongLink(service: service, url: url.absoluteString, title: title, artist: o.author_name ?? "", artworkURL: o.thumbnail_url)
    }

    private struct Lookup: Decodable {
        struct Item: Decodable {
            let trackName: String?
            let collectionName: String?
            let artistName: String?
            let artworkUrl100: String?
        }
        let results: [Item]
    }

    /// music.apple.com/<country>/album/<name>/<albumID>?i=<songID>  or  .../song/<name>/<songID>
    private static func appleMusic(_ url: URL) async throws -> SongLink {
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let songID = comps?.queryItems?.first(where: { $0.name == "i" })?.value
        let pathID = url.pathComponents.last(where: { $0.allSatisfy(\.isNumber) })
        guard let id = songID ?? pathID else { throw LinkError.notFound }
        let country = url.pathComponents.dropFirst().first.flatMap { $0.count == 2 ? $0 : nil } ?? "us"
        guard let api = URL(string: "https://itunes.apple.com/lookup?id=\(id)&country=\(country)") else { throw LinkError.notFound }
        let (data, _) = try await URLSession.shared.data(from: api)
        guard let item = try? JSONDecoder().decode(Lookup.self, from: data).results.first else { throw LinkError.notFound }
        return SongLink(service: "Apple Music", url: url.absoluteString,
                        title: item.trackName ?? item.collectionName ?? "",
                        artist: item.artistName ?? "",
                        artworkURL: item.artworkUrl100?.replacingOccurrences(of: "100x100", with: "600x600"))
    }

    /// A web search for printed sheet music of the song.
    static func sheetMusicSearchURL(for song: SongLink) -> URL? {
        let q = "\(song.title) \(song.artist) sheet music musicxml".addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return URL(string: "https://www.google.com/search?q=\(q)")
    }
}
