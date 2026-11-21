"""Instructions and answer schemas for reading sheet music with the vision model."""
from __future__ import annotations

from .mxl import INSTRUMENTS
from .notation import CLEFS

CLEF_LIST = sorted(CLEFS)
INSTRUMENT_KEYS = sorted(INSTRUMENTS)

READER_SYSTEM = """You transcribe printed or handwritten sheet music into a compact text notation for Haptune, a music practice app. Musicians practise from your transcription, so it must match the page exactly: same notes, rhythms, dynamics and markings. Never "improve" or simplify the music, never add notes that are not printed, never drop notes that are.

## Bar notation
Each voice of each bar is one string of space-separated tokens.

Notes: letter + accidental PRINTED in front of the note (if any) + octave, then "/" and the note value, e.g. F#4/8, Bb3/4, Cn5/16 (the letter always comes first).
- Middle C is C4. Treble clef: bottom line E4, top line F5. Bass clef: bottom line G2, top line A3. Alto clef: middle line C4. Tenor clef: second line from the top is C4.
- Write an accidental only when it is printed directly before that note (# ## b bb n). Do not add accidentals implied by the key signature or by an earlier note in the bar - those are applied automatically.
- For an octave clef (a small 8 under or over the clef), write notes as they read in the plain clef; the octave is adjusted automatically.
- Values: /1 whole, /2 half, /4 quarter, /8 eighth, /16, /32, /64. Dots follow: /4. dotted quarter, /8.. double-dotted eighth.

Other tokens:
- Chord (notes sharing one stem): C4+E4+G4/2
- Rest: r/4   Whole-bar rest (any metre): R
- Tie to the next note of the same pitch: G4/2~ G4/8 (a tie crossing the barline: mark ~ on the last note of the bar; the next bar starts with the tied note)
- Tuplets: 3( C5/8 D5/8 E5/8 ) is a triplet; other groups as N:M( ... ), e.g. 5:4( ... ). Write each note's printed value inside the group.
- Grace notes: g( D5/16 ) before the note they lead to.
- Clef change in the middle of a staff: clef=bass (or treble, alto, tenor, treble8vb).

Marks go right after a note or rest, no spaces, each starting with "!":
- Articulations: !stacc !accent !tenuto !marcato !staccatissimo !fermata !trill !mordent !turn !arpeggio !upbow !downbow !fing=3
- Slurs (curves joining different pitches): !slur-start on the first note, !slur-end on the last.
- Dynamics: !pp !p !mp !mf !f !ff !sf !sfz !fp ... on the note or rest they are printed under/over.
- Hairpins: !cresc-start / !cresc-end, !dim-start / !dim-end (also for the words cresc. / dim. with dashes).
- Text: !words="dolce"  Tempo marks: !tempo="Allegro" and !bpm=120 (quarter-note beats per minute; convert other beat units).
- Chord symbols above the staff: !chord="G7"   Lyrics: !ly="Twin-" (end with - when the word continues on the next note), second verse !ly2="..."
- Piano pedal: !ped=start / !ped=end
- More marks: !breath !caesura !prall (short trill) !tremolo (slashes through the stem) !harmonic (small circle) !open
Put dynamics written between the two staves of a piano part on the upper staff.

## Lead sheets, band scores, drums and guitar
- Lead sheets and band charts: write the melody as usual and put each chord symbol on the note or rest it is printed over (!chord="Am7"); a chord printed between two notes goes on the later one. Keep every chord symbol, also N.C.
- Rhythm slashes (slanted noteheads under chord symbols): write each as B4 with its value and !slash, e.g. B4/4!slash!chord="C" B4/4!slash B4/2!slash!chord="G7". A bar with chord symbols but no notes or slashes: write rests that place each chord where it is printed, e.g. r/2!chord="C" r/2!chord="G".
- A score for several instruments (band, ensemble, voice + piano + guitar...): every staff is its own part, in the order printed; never merge two instruments into one staff and never leave one out.
- Drum staff (percussion clef: two short thick lines; or a one-line rhythm staff): write each notehead by its position as if it were in treble clef, and add !x to x-shaped noteheads (hi-hat, ride, crash), !ox to a circled x (open hi-hat), !ghost to a note in brackets. Usual places: F4 bass drum, C5 snare, E5 and D5 toms, A4 floor tom, G5 hi-hat, F5 ride, A5 crash, D4 hi-hat pedal. Notes struck together are a chord (F4+G5/8!x). In the overview this part is instrument "percussion" with clef "percussion".
- Guitar or bass TAB (six or four lines with fret numbers instead of noteheads) is its own staff: give each fret number as the pitch it sounds, written one octave higher as guitar music is (guitar strings from the bottom TAB line: E3 A3 D4 G4 B4 E5 in written pitch; bass: E2 A2 D3 G3 written in bass clef; a fret number adds that many semitones). In the overview the TAB staff is a part with the same instrument and clef "treble8vb" (guitar) or "bass" (bass).

## Voices
Most staves have one voice: one string. When a staff has two independent rhythms (stems up and stems down), write two strings: voice 1 = the stems-up/upper part, voice 2 = the lower part. Notes that share a stem are a chord, not two voices.

## Checks before you answer
- Every voice of every bar must add up to the time signature (only the first bar - a pickup - and the last bar may be shorter). Count each bar; if it does not add up, look again at dots, tuplets, rests and beams.
- Every bar must list every staff of the system, top to bottom. Write R only when that staff shows a rest (or nothing) for the whole bar; if any notehead is printed on it, transcribe it. Missing bars are the most common mistake: check each staff of each bar for noteheads before writing R.
- Read each staff from its own five lines. Never copy the notes of one staff onto another (in violin + piano music, the violin and the piano's right hand often play different notes).
- For half and whole notes, find the line or space of the notehead by counting from the bottom line of its staff; long notes are easy to misplace by one step.
- Set "uncertain" only when a symbol is genuinely hard to see (smudged, cut off, overlapping). Do not set it out of general caution: the player is told about every bar marked uncertain, so it must mean something. If something is truly unreadable, give your best reading, set "uncertain": true and say what in "comment". Do not guess silently.
"""

OVERVIEW_PROMPT = """This is page {page} of {pages} of a score{hint}. Before the music is transcribed line by line, describe the score: its title and credits, the instruments (parts) from top to bottom of each system with how many staves each has and their clefs, the key and time signature at the start, any tempo marking, and whether the first bar is a pickup. Use the instrument key that fits best ("other" if none does). If this is not sheet music, set is_sheet_music to false."""

SYSTEM_PROMPT_TMPL = """Transcribe every bar of this line of music (one system: {staves_text}). {context}
Give x0 and x1 for each bar: the pixel x positions of the bar's left and right barlines in this image (for the first bar, x0 is where the first note area starts, after the clef and key signature)."""

LOCATE_PROMPT = """Before this page is transcribed, find every line of music on it. A line (system) is one staff, or several staves joined at the left by a barline or brace that are played together. For each system, from the top of the page to the bottom, give the pixel y position in this image of its top staff line ("top") and of its bottom staff line ("bottom"), and how many staves it has. Leave out titles, text and anything that is not a staff. If the page holds no music, return an empty list."""

REREAD_PROMPT_TMPL = """This image is a zoomed-in view of {what}. {context}
The first reading was:
{first}
Problem: {problem}
Read {target} again carefully from the image and return {count_text}. Keep everything that was right; fix what was wrong. Set x0 and x1 to 0."""


def _nullable(t: dict) -> dict:
    return {"anyOf": [t, {"type": "null"}]}


OVERVIEW_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["is_sheet_music", "title", "subtitle", "composer", "arranger", "lyricist", "tempo_text", "tempo_bpm",
                 "key_fifths", "mode", "time", "pickup", "parts", "handwritten", "notes"],
    "properties": {
        "is_sheet_music": {"type": "boolean"},
        "title": {"type": "string"}, "subtitle": {"type": "string"}, "composer": {"type": "string"},
        "arranger": {"type": "string"}, "lyricist": {"type": "string"},
        "tempo_text": {"type": "string"}, "tempo_bpm": _nullable({"type": "number"}),
        "key_fifths": {"type": "integer", "description": "sharps positive, flats negative"},
        "mode": {"type": "string", "enum": ["major", "minor"]},
        "time": {"type": "string", "description": "like 3/4, 6/8; C is 4/4, cut time is 2/2"},
        "pickup": {"type": "boolean"},
        "parts": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["name", "instrument", "staves", "clefs"],
            "properties": {
                "name": {"type": "string"},
                "instrument": {"type": "string", "enum": INSTRUMENT_KEYS},
                "staves": {"type": "integer"},
                "clefs": {"type": "array", "items": {"type": "string", "enum": CLEF_LIST}},
            }}},
        "handwritten": {"type": "boolean"},
        "notes": {"type": "string", "description": "anything unusual a transcriber should know"},
    },
}

MEASURE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["number", "time", "key_fifths", "repeat_start", "repeat_end", "ending", "barline", "x0", "x1",
                 "staves", "uncertain", "comment"],
    "properties": {
        "number": _nullable({"type": "integer"}),
        "time": _nullable({"type": "string"}),
        "key_fifths": _nullable({"type": "integer"}),
        "repeat_start": {"type": "boolean"}, "repeat_end": {"type": "boolean"},
        "ending": _nullable({"type": "string"}),
        "barline": {"type": "string", "enum": ["regular", "double", "final"]},
        "x0": {"type": "integer"}, "x1": {"type": "integer"},
        "staves": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["staff", "voices"],
            "properties": {"staff": {"type": "integer"}, "voices": {"type": "array", "items": {"type": "string"}}}}},
        "uncertain": {"type": "boolean"},
        "comment": {"type": "string"},
    },
}
MEASURE_DESCRIPTIONS = (
    "number: the printed bar number if one is printed on this bar, else null. time: a time signature printed AT "
    "this bar, else null. key_fifths: a key signature change printed at this bar (not the one repeated at the "
    "start of every line), else null. ending: '1', '2'... when the bar is under a volta bracket.")

SYSTEM_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["staff_count", "clefs", "key_fifths", "measures", "warnings"],
    "properties": {
        "staff_count": {"type": "integer"},
        "clefs": {"type": "array", "items": {"type": "string", "enum": CLEF_LIST}},
        "key_fifths": {"type": "integer", "description": "key signature printed at the start of this line"},
        "measures": {"type": "array", "items": MEASURE_SCHEMA, "description": MEASURE_DESCRIPTIONS},
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
}

LOCATE_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["systems"],
    "properties": {"systems": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["top", "bottom", "staves"],
        "properties": {"top": {"type": "integer"}, "bottom": {"type": "integer"}, "staves": {"type": "integer"}}}}},
}

REREAD_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["measures"],
    "properties": {"measures": {"type": "array", "items": MEASURE_SCHEMA}},
}
