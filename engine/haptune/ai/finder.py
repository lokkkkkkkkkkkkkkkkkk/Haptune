"""Find sheet music online for a song name or a YouTube / Spotify / Apple Music link.

The model searches the web (server-side web search and fetch tools) and reports candidates through a
strict tool: direct file links where possible, best formats first (MusicXML > MIDI > PDF), with the
source and licence. Only free, legitimate sources: public-domain libraries and arrangements their
authors share. Streaming links are used only to identify the song (title and artist from oEmbed);
nothing is downloaded from YouTube or other streaming services.

`safe_fetch` downloads a chosen file for the app, refusing private network addresses and big files.
"""
from __future__ import annotations

import ipaddress
import json
import re
import socket
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from .claude import Claude

FORMAT_ORDER = {"musicxml": 0, "mxl": 0, "midi": 1, "abc": 2, "pdf": 3, "page": 4}

FINDER_SYSTEM = """You find sheet music for Haptune, a music practice app, and report it with the report_sheet_music tool.

Rules:
- Only free and legitimate sources: public-domain libraries (IMSLP, Mutopia Project, CPDL, Wikimedia Commons, OpenScore, Musopen, the Petrucci library mirrors), free arrangements shared by their arrangers (for example on MuseScore.com or arrangers' own sites), and composers' or publishers' own free downloads. Never suggest copies of copyrighted sheet music that the uploader had no right to share, paywalled previews, or download/converter sites.
- Prefer files the app can play directly: MusicXML (.mxl or .musicxml) first, then MIDI (.mid), then ABC, then PDF. A PDF is still useful: the app reads printed music.
- file_url must be a direct link to the file that you saw in a search result or a fetched page. Use web_fetch on a promising page to find the actual download link. If a page only lets people view or buy the music, set file_url to null and keep page_url.
- Match the player's instrument when there is a choice, and say how hard each version is.
- For a recent copyrighted song, free legal sheet music is rare. Say so plainly in advice, list any free arrangements you do find, and mention that the player can buy official sheet music or use the app's "From a recording" option.
- Report at most 8 candidates, best first. Report even if you found nothing (empty list, with advice).
"""

REPORT_TOOL = {
    "name": "report_sheet_music",
    "description": "Report the sheet music you found for the song.",
    "strict": True,
    "input_schema": {
        "type": "object", "additionalProperties": False,
        "required": ["song", "candidates", "advice", "listen_url"],
        "properties": {
            "song": {"type": "object", "additionalProperties": False, "required": ["title", "artist", "copyrighted"],
                     "properties": {"title": {"type": "string"}, "artist": {"type": "string"},
                                    "copyrighted": {"type": "boolean", "description": "true if the music is still under copyright"}}},
            "candidates": {"type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": ["title", "arrangement", "instrument", "level", "format", "file_url", "page_url", "source",
                             "license", "pages"],
                "properties": {
                    "title": {"type": "string"},
                    "arrangement": {"type": "string", "description": "e.g. 'Piano solo, simplified' or 'Original for violin and piano'"},
                    "instrument": {"type": "string"},
                    "level": {"type": "string", "enum": ["beginner", "easy", "intermediate", "advanced", "unknown"]},
                    "format": {"type": "string", "enum": ["musicxml", "mxl", "midi", "abc", "pdf", "page"]},
                    "file_url": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                    "page_url": {"type": "string"},
                    "source": {"type": "string", "description": "site or library name"},
                    "license": {"type": "string", "description": "e.g. 'Public domain', 'CC BY 4.0', 'Free (arranger)', 'Unknown'"},
                    "pages": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
                }}},
            "advice": {"type": "string", "description": "one or two friendly sentences for the player"},
            "listen_url": {"anyOf": [{"type": "string"}, {"type": "null"}],
                           "description": "a YouTube link to a good performance of this song, if you saw one"},
        },
    },
}


# ---------------------------------------------------------------------------- links
def youtube_id(url: str) -> str | None:
    try:
        u = urllib.parse.urlparse(url.strip())
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    vid = None
    if host.endswith("youtu.be"):
        vid = u.path.strip("/").split("/")[0]
    elif "youtube.com" in host or "youtube-nocookie.com" in host:
        q = urllib.parse.parse_qs(u.query)
        if q.get("v"):
            vid = q["v"][0]
        else:
            m = re.match(r"^/(?:embed|shorts|live|v)/([^/?#]+)", u.path)
            vid = m.group(1) if m else None
    return vid if vid and re.fullmatch(r"[A-Za-z0-9_-]{6,20}", vid) else None


def _get_json(url: str, timeout: float = 8.0) -> dict | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Haptune/1.0 (music practice app)"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read(400_000).decode("utf-8", "replace"))
    except Exception:
        return None


def resolve_link(link: str) -> dict | None:
    """Title and artist of a YouTube, Spotify or Apple Music link (oEmbed / iTunes lookup)."""
    link = (link or "").strip()
    m = re.search(r"https?://\S+", link)
    if not m:
        return None
    url = m.group(0)
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    if "youtu" in host:
        data = _get_json("https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(url, safe=""))
        vid = youtube_id(url)
        if data:
            return {"service": "YouTube", "title": data.get("title", ""), "artist": data.get("author_name", ""),
                    "thumbnail": data.get("thumbnail_url"), "youtube_id": vid, "url": url}
        return {"service": "YouTube", "title": "", "artist": "", "youtube_id": vid, "url": url}
    if "spotify" in host:
        data = _get_json("https://open.spotify.com/oembed?url=" + urllib.parse.quote(url, safe=""))
        if data:
            return {"service": "Spotify", "title": data.get("title", ""), "artist": "", "thumbnail": data.get("thumbnail_url"), "url": url}
    if "music.apple.com" in host or "itunes.apple.com" in host:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        ids = q.get("i") or re.findall(r"/(\d{5,})(?:\?|$)", url)
        if ids:
            data = _get_json(f"https://itunes.apple.com/lookup?id={ids[0]}")
            if data and data.get("results"):
                it = data["results"][0]
                return {"service": "Apple Music", "title": it.get("trackName") or it.get("collectionName") or "",
                        "artist": it.get("artistName", ""), "thumbnail": it.get("artworkUrl100"), "url": url}
    return {"service": "link", "title": "", "artist": "", "url": url}


def _clean_title(title: str) -> str:
    """'Song (Official Video) [4K] | Artist' -> 'Song'."""
    t = re.sub(r"[\(\[](official|lyrics?|audio|video|mv|hd|4k|live|visualizer|piano|cover|tutorial)[^\)\]]*[\)\]]", "", title, flags=re.I)
    t = re.split(r"\s[|•]\s", t)[0]
    return re.sub(r"\s{2,}", " ", t).strip(" -–")


# ---------------------------------------------------------------------------- safe downloads
class FetchError(RuntimeError):
    pass


def _public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            return False
    return True


def check_url(url: str) -> str:
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise FetchError("Only web links can be downloaded.")
    if u.port not in (None, 80, 443, 8080, 8443):
        raise FetchError("That link uses an unusual port.")
    if not _public_host(u.hostname):
        raise FetchError("That address can't be reached from the server.")
    return url


class _CheckedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def safe_fetch(url: str, max_bytes: int = 30 * 1024 * 1024, timeout: float = 25.0) -> tuple[bytes, str, str]:
    """Downloads a public web file. Returns (bytes, content type, final url)."""
    check_url(url)
    opener = urllib.request.build_opener(_CheckedRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; Haptune/1.0; music practice app)",
                                               "Accept": "*/*"})
    try:
        with opener.open(req, timeout=timeout) as r:
            ctype = r.headers.get("Content-Type", "application/octet-stream").split(";")[0].strip()
            length = int(r.headers.get("Content-Length") or 0)
            if length > max_bytes:
                raise FetchError("That file is too big.")
            data = r.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise FetchError("That file is too big.")
            return data, ctype, r.geturl()
    except FetchError:
        raise
    except Exception as e:
        raise FetchError(f"The file could not be downloaded ({type(e).__name__}).") from e


def sniff_format(data: bytes, name: str = "", ctype: str = "") -> str | None:
    head = data[:2048]
    low = name.lower()
    if head.startswith(b"%PDF"):
        return "pdf"
    if head.startswith(b"MThd"):
        return "midi"
    if head.startswith(b"PK"):
        return "mxl" if (low.endswith(".mxl") or b"META-INF" in data[:4096] or b".xml" in data[:4096]) else None
    text = head.decode("utf-8", "ignore")
    if "<score-partwise" in data[:20000].decode("utf-8", "ignore") or "<score-timewise" in data[:20000].decode("utf-8", "ignore"):
        return "musicxml"
    if re.search(r"^X:\s*\d", text, re.M) and re.search(r"^K:", text, re.M):
        return "abc"
    return None


def _verify(c: dict) -> dict:
    url = c.get("file_url")
    c["verified"] = False
    if not url:
        return c
    try:
        check_url(url)
        opener = urllib.request.build_opener(_CheckedRedirect)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; Haptune/1.0)", "Range": "bytes=0-4095"})
        with opener.open(req, timeout=8) as r:
            head = r.read(4096)
        fmt = sniff_format(head, url)
        if fmt:
            c["verified"] = True
            c["format"] = "musicxml" if fmt == "mxl" and c.get("format") == "musicxml" else fmt
    except Exception:
        pass
    return c


# ---------------------------------------------------------------------------- the search
def find_music(query: str = "", link: str = "", instrument: str = "", ai: Claude | None = None, verify: bool = True) -> dict:
    ai = ai or Claude()
    song = resolve_link(link) if link else None
    title = (query or "").strip()
    if song and song.get("title"):
        title = title or _clean_title(song["title"])
    if not title:
        raise ValueError("Type a song name or paste a link.")
    who = f" (the link's channel/artist: {song['artist']})" if song and song.get("artist") else ""
    inst = f" The player plays {instrument}." if instrument else ""
    user = f"Find sheet music for: {title}{who}.{inst} Report what you find with report_sheet_music."
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 6},
             {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 6},
             REPORT_TOOL]
    found = ai.run_tools(FINDER_SYSTEM, user, tools, final_tool="report_sheet_music", effort="medium") or {}
    cands = [c for c in (found.get("candidates") or []) if isinstance(c, dict)][:8]
    for c in cands:
        if c.get("file_url") and not re.match(r"^https?://", c["file_url"]):
            c["file_url"] = None
    if verify and cands:
        with ThreadPoolExecutor(max_workers=6) as pool:
            cands = list(pool.map(_verify, cands))
    cands.sort(key=lambda c: (0 if c.get("verified") else 1, FORMAT_ORDER.get(c.get("format"), 9)))
    listen = None
    if song and song.get("youtube_id"):
        listen = song["youtube_id"]
    elif found.get("listen_url"):
        listen = youtube_id(found["listen_url"])
    info = found.get("song") or {}
    return {
        "song": {"title": info.get("title") or title, "artist": info.get("artist") or (song or {}).get("artist", ""),
                 "copyrighted": bool(info.get("copyrighted")), "from_link": song},
        "candidates": cands,
        "advice": found.get("advice") or "",
        "youtube_id": listen,
        "usage": ai.usage.to_json(),
    }
