"""Instrument profiles.

Every analysis decision that depends on the instrument lives here, so the
Python engine and the Swift app (which loads `instruments.json`, exported
from this file) always agree.

Pitches are MIDI note numbers at *sounding* pitch (middle C = 60, A4 = 69).
`transpose` is what must be added to a WRITTEN pitch to get the SOUNDING
pitch (same convention as MusicXML <transpose>). Example: B-flat clarinet
reads C5 (72) and sounds B-flat4 (70), so transpose = -2.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class InstrumentProfile:
    key: str
    name: str
    family: str                 # keyboard | strings | plucked | voice | woodwind | brass | chinese | percussion
    low: int                    # lowest sounding MIDI pitch
    high: int                   # highest sounding MIDI pitch
    transpose: int = 0          # written -> sounding, semitones
    mode: str = "mono"          # mono | poly | rhythm
    max_polyphony: int = 1
    intonation: bool = False    # give sharp/flat feedback?
    cents_ok: float = 20.0      # |deviation| up to this is "in tune"
    cents_warn: float = 35.0    # beyond this is "out of tune" (between = slightly off)
    onset_style: str = "legato"  # percussive | legato
    min_note_ms: float = 70.0   # shorter detected notes are treated as noise / slides
    open_strings: tuple = field(default_factory=tuple)  # for the tuner, sounding MIDI
    vibrato: bool = False       # judge pitch on the median of the sustain, not the peak
    chord_spread_ms: float = 60.0  # notes this close together count as one chord / event

    @property
    def fmin(self) -> float:
        return midi_to_hz(self.low - 2)

    @property
    def fmax(self) -> float:
        return midi_to_hz(self.high + 2)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["open_strings"] = list(self.open_strings)
        return d


def midi_to_hz(m: float, a4: float = 440.0) -> float:
    return a4 * 2.0 ** ((m - 69.0) / 12.0)


def hz_to_midi(f: float, a4: float = 440.0) -> float:
    import math
    return 69.0 + 12.0 * math.log2(f / a4)


_P = InstrumentProfile
PROFILES: dict[str, InstrumentProfile] = {p.key: p for p in [
    # Keyboard ------------------------------------------------------------
    _P("piano", "Piano", "keyboard", 21, 108, mode="poly", max_polyphony=10,
       onset_style="percussive", min_note_ms=40, chord_spread_ms=70),
    _P("keyboard", "Keyboard / digital piano", "keyboard", 28, 103, mode="poly", max_polyphony=10,
       onset_style="percussive", min_note_ms=40, chord_spread_ms=70),
    # Bowed strings ---------------------------------------------------------
    _P("violin", "Violin", "strings", 55, 100, max_polyphony=2, intonation=True, cents_ok=15,
       cents_warn=30, open_strings=(55, 62, 69, 76), vibrato=True),
    _P("viola", "Viola", "strings", 48, 88, max_polyphony=2, intonation=True, cents_ok=15,
       cents_warn=30, open_strings=(48, 55, 62, 69), vibrato=True),
    _P("cello", "Cello", "strings", 36, 76, max_polyphony=2, intonation=True, cents_ok=15,
       cents_warn=30, open_strings=(36, 43, 50, 57), vibrato=True),
    _P("double_bass", "Double bass", "strings", 28, 67, transpose=-12, intonation=True,
       cents_ok=20, cents_warn=35, open_strings=(28, 33, 38, 43), min_note_ms=90, vibrato=True),
    # Plucked / fretted ------------------------------------------------------
    _P("guitar", "Guitar", "plucked", 40, 88, transpose=-12, mode="poly", max_polyphony=6,
       onset_style="percussive", open_strings=(40, 45, 50, 55, 59, 64), min_note_ms=50,
       chord_spread_ms=90),
    _P("bass_guitar", "Bass guitar", "plucked", 28, 67, transpose=-12, onset_style="percussive",
       open_strings=(28, 33, 38, 43), min_note_ms=60),
    _P("ukulele", "Ukulele", "plucked", 60, 81, mode="poly", max_polyphony=4,
       onset_style="percussive", open_strings=(67, 60, 64, 69), min_note_ms=50, chord_spread_ms=90),
    # Voice -------------------------------------------------------------------
    _P("voice_soprano", "Voice (soprano)", "voice", 58, 86, intonation=True, cents_ok=25,
       cents_warn=45, vibrato=True, min_note_ms=90),
    _P("voice_alto", "Voice (alto)", "voice", 52, 79, intonation=True, cents_ok=25,
       cents_warn=45, vibrato=True, min_note_ms=90),
    _P("voice_tenor", "Voice (tenor)", "voice", 46, 72, intonation=True, cents_ok=25,
       cents_warn=45, vibrato=True, min_note_ms=90),
    _P("voice_bass", "Voice (bass/baritone)", "voice", 38, 67, intonation=True, cents_ok=25,
       cents_warn=45, vibrato=True, min_note_ms=90),
    # Woodwind ------------------------------------------------------------------
    _P("flute", "Flute", "woodwind", 59, 98, intonation=True, cents_ok=20, cents_warn=35),
    _P("recorder", "Recorder (soprano)", "woodwind", 72, 98, transpose=12, intonation=True,
       cents_ok=25, cents_warn=45),
    _P("clarinet", "Clarinet in B-flat", "woodwind", 50, 91, transpose=-2, intonation=True,
       cents_ok=20, cents_warn=35),
    _P("alto_sax", "Alto saxophone", "woodwind", 49, 81, transpose=-9, intonation=True,
       cents_ok=20, cents_warn=35),
    _P("tenor_sax", "Tenor saxophone", "woodwind", 44, 76, transpose=-14, intonation=True,
       cents_ok=20, cents_warn=35),
    # Brass ---------------------------------------------------------------------
    _P("trumpet", "Trumpet in B-flat", "brass", 52, 84, transpose=-2, intonation=True,
       cents_ok=20, cents_warn=35),
    _P("trombone", "Trombone", "brass", 40, 72, intonation=True, cents_ok=20, cents_warn=35),
    _P("french_horn", "Horn in F", "brass", 34, 77, transpose=-7, intonation=True,
       cents_ok=20, cents_warn=35),
    # Chinese traditional (popular with learners in Malaysia, Taiwan, China) ------
    _P("erhu", "Erhu", "chinese", 62, 93, intonation=True, cents_ok=20, cents_warn=35,
       open_strings=(62, 69), vibrato=True),
    _P("dizi", "Dizi (D)", "chinese", 69, 96, intonation=True, cents_ok=25, cents_warn=40),
    _P("guzheng", "Guzheng", "chinese", 38, 86, mode="poly", max_polyphony=4,
       onset_style="percussive", min_note_ms=50, chord_spread_ms=80),
    # Rhythm only (drums, percussion, clapping): pitch ignored, only timing judged --
    _P("percussion", "Percussion / clapping (rhythm only)", "percussion", 0, 127, mode="rhythm",
       onset_style="percussive", min_note_ms=30),
]}


def get_profile(key: str | None) -> InstrumentProfile:
    if not key:
        return PROFILES["piano"]
    key = key.lower().strip()
    if key in PROFILES:
        return PROFILES[key]
    aliases = {
        "voice": "voice_soprano", "vocal": "voice_soprano", "vocals": "voice_soprano",
        "soprano": "voice_soprano", "alto": "voice_alto", "tenor": "voice_tenor",
        "bass": "voice_bass", "baritone": "voice_bass", "sax": "alto_sax",
        "saxophone": "alto_sax", "horn": "french_horn", "drums": "percussion",
        "acoustic guitar": "guitar", "electric guitar": "guitar", "classical guitar": "guitar",
        "contrabass": "double_bass", "violoncello": "cello", "clarinet in b-flat": "clarinet",
    }
    if key in aliases:
        return PROFILES[aliases[key]]
    for k, p in PROFILES.items():           # loose match on display name
        if key in p.name.lower():
            return p
    raise KeyError(f"Unknown instrument '{key}'. Known: {', '.join(PROFILES)}")


def guess_profile(part_name: str = "", midi_program: int | None = None) -> InstrumentProfile:
    """Best-effort instrument guess from a MusicXML part name or General MIDI program (1-based)."""
    name = (part_name or "").lower()
    keywords = [
        ("piano", "piano"), ("klavier", "piano"), ("keyboard", "keyboard"), ("violin", "violin"),
        ("violino", "violin"), ("viola", "viola"), ("cello", "cello"), ("violoncello", "cello"),
        ("contrabass", "double_bass"), ("double bass", "double_bass"), ("bass guitar", "bass_guitar"),
        ("guitar", "guitar"), ("ukulele", "ukulele"), ("soprano", "voice_soprano"),
        ("alto sax", "alto_sax"), ("tenor sax", "tenor_sax"), ("alto", "voice_alto"),
        ("tenor", "voice_tenor"), ("bass", "voice_bass"), ("baritone", "voice_bass"),
        ("voice", "voice_soprano"), ("vocal", "voice_soprano"), ("flute", "flute"),
        ("recorder", "recorder"), ("clarinet", "clarinet"), ("trumpet", "trumpet"),
        ("trombone", "trombone"), ("horn", "french_horn"), ("erhu", "erhu"), ("二胡", "erhu"),
        ("dizi", "dizi"), ("笛", "dizi"), ("guzheng", "guzheng"), ("古筝", "guzheng"),
        ("drum", "percussion"), ("percussion", "percussion"),
    ]
    for word, key in keywords:
        if word in name:
            return PROFILES[key]
    if midi_program:
        gm = midi_program
        if 1 <= gm <= 8:
            return PROFILES["piano"]
        if gm in (25, 26, 27, 28, 29, 30, 31, 32):
            return PROFILES["guitar"]
        if gm in (33, 34, 35, 36, 37, 38, 39, 40):
            return PROFILES["bass_guitar"]
        if gm == 41:
            return PROFILES["violin"]
        if gm == 42:
            return PROFILES["viola"]
        if gm == 43:
            return PROFILES["cello"]
        if gm == 44:
            return PROFILES["double_bass"]
        if gm in (53, 54, 55):
            return PROFILES["voice_soprano"]
        if gm == 57:
            return PROFILES["trumpet"]
        if gm == 58:
            return PROFILES["trombone"]
        if gm == 61:
            return PROFILES["french_horn"]
        if gm in (66,):
            return PROFILES["alto_sax"]
        if gm in (67,):
            return PROFILES["tenor_sax"]
        if gm == 72:
            return PROFILES["clarinet"]
        if gm == 74:
            return PROFILES["flute"]
        if gm == 75:
            return PROFILES["recorder"]
    return PROFILES["piano"]


def export_json(path: str) -> None:
    """Write instruments.json for the Swift app."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"schema": "haptune.instruments/1",
                   "instruments": [p.to_dict() for p in PROFILES.values()]}, f, indent=1,
                  ensure_ascii=False)
