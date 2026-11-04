"""Band split: one mixed recording -> a part (audio + sheet music) for every instrument.

    separate (separate.py) -> lead line out of "other" (lead.py) -> one shared beat grid
    -> transcribe each part -> chords for the accompaniment (chords.py) -> multi-part Score,
    MusicXML, practice stems (.m4a) and an HTML report with a mixer.

The app sends the instruments the user says are playing ("voice, violin, keyboard"); they decide
which stems become which parts. Without hints every active stem becomes a part.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from dataclasses import dataclass, field

import numpy as np

from . import chords as chordlib
from . import dsp
from .instruments import get_profile
from .lead import extract_lead
from .master_score import _beat_position, _quantise, estimate_key, estimate_tempo, track_beats
from .score import Measure, Note, Part, Score
from .separate import SR as SEP_SR
from .separate import load_stereo, separate
from .transcribe import DetectedNote, transcribe_mono

ROLE_ORDER = ["vocals", "lead", "keys", "bass", "drums"]
LEAD_INSTRUMENTS = ["violin", "viola", "cello", "erhu", "flute", "dizi", "recorder", "clarinet", "alto_sax",
                    "tenor_sax", "trumpet", "trombone", "french_horn"]
KEYS_INSTRUMENTS = ["keyboard", "piano", "guitar", "ukulele", "guzheng"]
ROLE_NAMES = {"vocals": "Voice", "lead": "Melody", "keys": "Accompaniment", "bass": "Bass", "drums": "Drums"}
SHORT_NAMES = {"keyboard": "Keyboard", "piano": "Piano", "guitar": "Guitar", "ukulele": "Ukulele", "guzheng": "Guzheng",
               "violin": "Violin", "viola": "Viola", "cello": "Cello", "erhu": "Erhu", "flute": "Flute", "dizi": "Dizi",
               "recorder": "Recorder", "clarinet": "Clarinet", "alto_sax": "Alto sax", "tenor_sax": "Tenor sax",
               "trumpet": "Trumpet", "trombone": "Trombone", "french_horn": "Horn"}
NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]


@dataclass
class BandPart:
    id: str
    role: str
    instrument: str
    name: str
    audio: np.ndarray                          # stereo, 44.1 kHz
    activity: list = field(default_factory=list)
    notes: list = field(default_factory=list)  # DetectedNote
    track: object = None                       # PitchTrack for lead (from the contours)


def plan(instruments: list[str] | None) -> dict[str, str]:
    """User's instrument list -> {role: instrument profile key}."""
    roles: dict[str, str] = {}
    for raw in instruments or []:
        k = raw.strip().lower().replace(" ", "_")
        if not k:
            continue
        if k in ("voice", "vocal", "vocals", "singer") or k.startswith("voice"):
            roles.setdefault("vocals", k if k.startswith("voice_") else "voice")
        elif k in ("drums", "percussion"):
            roles.setdefault("drums", "percussion")
        elif k in ("bass", "bass_guitar", "double_bass") and "bass" not in roles:
            roles["bass"] = "bass_guitar" if k != "double_bass" else "double_bass"
        elif get_profile(k).key in LEAD_INSTRUMENTS and "lead" not in roles:
            roles["lead"] = get_profile(k).key
        elif get_profile(k).key in KEYS_INSTRUMENTS and "keys" not in roles:
            roles["keys"] = get_profile(k).key
    return roles


def activity(stereo: np.ndarray, sr: int = SEP_SR, ref_db: float | None = None) -> list[float]:
    """0..1 loudness per second (relative to the loudest part of the song)."""
    m = stereo.mean(axis=1) if stereo.ndim == 2 else stereo
    n = int(math.ceil(len(m) / sr))
    db = np.array([10 * np.log10(np.mean(m[i * sr:(i + 1) * sr] ** 2) + 1e-12) for i in range(n)])
    top = ref_db if ref_db is not None else float(np.percentile(db, 95))
    return [round(float(np.clip((d - (top - 30)) / 30, 0, 1)), 2) for d in db]


def _mono22(stereo: np.ndarray) -> np.ndarray:
    from scipy.signal import resample_poly
    m = stereo.mean(axis=1) if stereo.ndim == 2 else stereo
    return resample_poly(m, 1, 2).astype(np.float32)          # 44.1 kHz -> 22.05 kHz


def _voice_profile(y22: np.ndarray):
    tr = dsp.yin(y22, fmin=80, fmax=1100)
    med = float(np.nanmedian(tr.midi)) if np.isfinite(tr.midi).any() else 64
    for key, top in (("voice_bass", 52), ("voice_tenor", 58), ("voice_alto", 64)):
        if med < top:
            return get_profile(key)
    return get_profile("voice_soprano")


def _lead_track(res, y22: np.ndarray) -> dsp.PitchTrack:
    """Turn the lead contours into a PitchTrack so transcribe_mono can segment notes from it."""
    midi = res.midi.astype(float)
    hop = dsp.HOP
    n = len(midi)
    frames = np.arange(n) * hop
    rms = np.array([np.sqrt(np.mean(y22[f:f + 1024] ** 2)) if f < len(y22) else 0.0 for f in frames])
    voiced = np.isfinite(midi)
    f0 = np.where(voiced, 440.0 * 2 ** ((np.nan_to_num(midi, nan=69.0) - 69) / 12), 0.0)
    conf = np.where(voiced, 0.9, 0.0)
    return dsp.PitchTrack(times=res.times, f0=f0, confidence=conf, rms=rms, midi=np.where(voiced, midi, np.nan),
                          alt_lower=np.ones(n), voiced=voiced)


def _keys_notes(spans: list[dict], beats_per_bar: int, total_beats: float) -> list[tuple[float, float, int]]:
    """A playable keyboard part from the chord chart: close-position triads (smooth voice leading)
    in the right hand, the root in the left hand."""
    out = []
    prev = [60, 64, 67]
    for k, s in enumerate(spans):
        start = float(s["beat"])
        end = float(spans[k + 1]["beat"]) if k + 1 < len(spans) else total_beats
        if end - start <= 0 or not s["pcs"]:
            continue
        pcs = s["pcs"][:3]
        best, best_cost = None, 1e9
        for base in range(52, 68):                         # candidate voicings around middle C
            v = []
            for pc in pcs:
                p = base + ((pc - base) % 12)
                v.append(p)
            v.sort()
            if v[-1] - v[0] > 12:
                continue
            cost = sum(abs(a - b) for a, b in zip(v, prev))
            if cost < best_cost:
                best, best_cost = v, cost
        voicing = best or [60 + pcs[0], 64, 67]
        prev = voicing
        # re-strike at each bar line so long chords stay readable
        t = start
        while t < end - 1e-6:
            bar_end = (math.floor(t / beats_per_bar) + 1) * beats_per_bar
            d = min(end, bar_end) - t
            for p in voicing:
                out.append((t, d, p))
            out.append((t, d, 36 + ((s["root"] - 36) % 12)))
            t += d
    return out


def _quantise_notes(notes: list[DetectedNote], beats: np.ndarray, shift: float) -> list[tuple[float, float, DetectedNote]]:
    q = []
    for n in notes:
        on = _beat_position(n.onset, beats) - shift
        off = _beat_position(n.offset, beats) - shift
        if on < -0.01:
            continue
        qo = max(0.0, _quantise(on))
        qd = max(0.25, _quantise(off - on) if off - on > 0.2 else 0.25)
        q.append((qo, qd, n))
    # one note per onset per part (monophonic lines)
    seen, out = set(), []
    for qo, qd, n in sorted(q, key=lambda x: (x[0], -(x[2].energy or 0))):
        if round(qo, 3) in seen:
            continue
        seen.add(round(qo, 3))
        out.append((qo, qd, n))
    # a note lasts until the next one at most
    for i in range(len(out) - 1):
        qo, qd, n = out[i]
        out[i] = (qo, max(0.25, min(qd, out[i + 1][0] - qo)), n)
    return out


def encode_m4a(stereo: np.ndarray, path: str, sr: int = SEP_SR, bitrate: str = "128k") -> str:
    """Practice stem for the app: AAC in .m4a (plays everywhere, ~1 MB per minute)."""
    import soundfile as sf
    wav = path.rsplit(".", 1)[0] + ".tmp.wav"
    peak = float(np.max(np.abs(stereo))) if stereo.size else 1.0
    sf.write(wav, (stereo / max(1.0, peak / 0.98)).astype(np.float32), sr)
    if shutil.which("ffmpeg"):
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav, "-c:a", "aac", "-b:a", bitrate, path], check=True)
        os.remove(wav)
        return path
    os.replace(wav, path.rsplit(".", 1)[0] + ".wav")
    return path.rsplit(".", 1)[0] + ".wav"


def band_split(path: str, out_dir: str, instruments: list[str] | None = None, title: str | None = None,
               backend: str = "auto", progress=None, beats_per_bar: int | None = None) -> dict:
    """Runs the whole pipeline. Writes stems + score + report into out_dir; returns the result JSON."""
    say = progress or (lambda stage, frac: None)
    os.makedirs(out_dir, exist_ok=True)
    say("loading", 0.0)
    mix = load_stereo(path)
    duration = len(mix) / SEP_SR
    stems = separate(mix, backend=backend, progress=say)
    roles = plan(instruments)
    explicit = bool(roles)
    mix_db = 10 * np.log10(np.mean(mix ** 2) + 1e-12)
    ref_db = float(np.percentile([10 * np.log10(np.mean(mix[i:i + SEP_SR].mean(axis=1) ** 2) + 1e-12)
                                  for i in range(0, len(mix), SEP_SR)], 95))

    def is_active(x: np.ndarray, min_share: float = 0.06) -> bool:
        a = np.array(activity(x, ref_db=ref_db))
        return 10 * np.log10(np.mean(x ** 2) + 1e-12) > mix_db - 30 and (a > 0.3).mean() > min_share

    parts: list[BandPart] = []
    if ("vocals" in roles or not explicit) and is_active(stems["vocals"]):
        parts.append(BandPart("vocals", "vocals", roles.get("vocals", "voice"), "Voice", stems["vocals"]))
    other = stems["other"] + stems.get("piano", 0) + (stems.get("guitar", 0) if roles.get("keys") != "guitar" else 0)
    if "lead" in roles or not explicit:
        say("lead", 0.0)
        prof = get_profile(roles.get("lead", "violin"))
        res = extract_lead(other, SEP_SR, prof)
        lead_part = BandPart("lead", "lead", prof.key, SHORT_NAMES.get(prof.key, prof.name) if "lead" in roles else "Melody", res.lead)
        lead_part.track = res
        if is_active(res.lead, 0.04):
            parts.append(lead_part)
            other = res.rest
        say("lead", 1.0)
    keys_key = roles.get("keys", "keyboard")
    if roles.get("keys") == "guitar" and "guitar" in stems:
        other = other + stems["guitar"]
    if is_active(other):
        parts.append(BandPart("keys", "keys", keys_key, SHORT_NAMES.get(keys_key, "Keyboard") if "keys" in roles else "Accompaniment", other))
    if ("bass" in roles or not explicit or "keys" in roles) and is_active(stems["bass"], 0.15):
        parts.append(BandPart("bass", "bass", roles.get("bass", "bass_guitar"), "Bass", stems["bass"]))
    if is_active(stems["drums"], 0.10):
        parts.append(BandPart("drums", "drums", "percussion", "Drums", stems["drums"]))
    for p in parts:
        p.activity = activity(p.audio, ref_db=ref_db)

    # ---- one beat grid for everybody ----
    say("transcribe", 0.0)
    y_mix = _mono22(mix)
    _, odf = dsp.detect_onsets(y_mix, dsp.SR, dsp.HOP)
    hop_s = dsp.HOP / dsp.SR
    bpm = estimate_tempo(odf, hop_s)
    beats = track_beats(odf, hop_s, bpm)
    if len(beats) >= 4:
        bpm = 60.0 / float(np.median(np.diff(beats)))

    # ---- notes per part ----
    for i, p in enumerate(parts):
        y22 = _mono22(p.audio)
        if p.role == "vocals":
            prof = _voice_profile(y22) if p.instrument == "voice" else get_profile(p.instrument)
            p.instrument = prof.key
            p.notes = [n for n in transcribe_mono(y22, prof) if n.pitch is not None]
        elif p.role == "lead":
            prof = get_profile(p.instrument)
            p.notes = [n for n in transcribe_mono(y22, prof, track=_lead_track(p.track, y22)) if n.pitch is not None]
        elif p.role == "bass":
            p.notes = [n for n in transcribe_mono(y22, get_profile("bass_guitar")) if n.pitch is not None]
        say("transcribe", (i + 1) / max(1, len(parts)))

    # score beat 0 = the first beat at or before the first note of any part
    firsts = [min(n.onset for n in p.notes) for p in parts if p.notes]
    first_t = min(firsts) if firsts else (beats[0] if len(beats) else 0.0)
    shift = math.floor(_beat_position(first_t, beats) + 0.25)
    bpb = beats_per_bar or 4
    offset = float(np.interp(shift, np.arange(len(beats)), beats)) if len(beats) > 1 and shift >= 0 else \
        (float(beats[0]) + shift * 60.0 / bpm if len(beats) else 0.0)

    quantised = {p.id: _quantise_notes(p.notes, beats, shift) for p in parts if p.notes}
    all_p, all_w = [], []
    for q in quantised.values():
        for _, d, n in q:
            all_p.append(n.pitch)
            all_w.append(d)

    # ---- chords for the accompaniment ----
    say("chords", 0.0)
    keys = next((p for p in parts if p.role == "keys"), None)
    spans = []
    if keys is not None and len(beats) > 4:
        acc = keys.audio + next((p.audio for p in parts if p.role == "bass"), 0)
        spans = chordlib.chord_spans(_mono22(acc), beats, dsp.SR, min_beats=2)
        for s in spans:
            s["beat"] = s["beat"] - shift
        spans = [s for s in spans if s["beat"] >= 0]
        for s in spans:
            if s["root"] is not None:
                all_p.append(48 + s["root"])
                all_w.append(2.0)
    tonic, mode, fifths = estimate_key(all_p or [60], all_w or [1.0])
    for s in spans:                                   # spell chords for the key
        s["label"] = chordlib.name(s["root"], s["quality"], fifths)
    spans = [s for k, s in enumerate(spans) if k == 0 or s["label"] != spans[k - 1]["label"]]

    # ---- the multi-part score ----
    end_beats = [qo + qd for q in quantised.values() for qo, qd, _ in q] + [s["beat"] + 1 for s in spans]
    total = max(end_beats) if end_beats else bpb
    n_bars = max(1, int(math.ceil(total / bpb)))
    measures = [Measure(i, str(i + 1), i * bpb, bpb, (bpb, 4), fifths, mode, i) for i in range(n_bars)]
    score_parts, snotes, part_ids = [], [], {}
    for p in parts:
        if p.role == "drums":
            continue
        if p.role != "keys" and not quantised.get(p.id):
            continue
        pid = f"P{len(score_parts) + 1}"
        part_ids[p.id] = pid
        prof = get_profile(p.instrument)
        score_parts.append(Part(pid, p.name, prof.key, prof.transpose))
        if p.role == "keys":
            for k, (on, d, pitch) in enumerate(_keys_notes(spans, bpb, n_bars * bpb)):
                snotes.append(Note(id=f"{p.id}-{k}", part=pid, measure=min(n_bars - 1, int(on // bpb)), onset=on,
                                   duration=d, pitch=pitch, written=pitch, src_index=len(snotes) + 1))
        else:
            for k, (qo, qd, n) in enumerate(quantised[p.id]):
                snotes.append(Note(id=f"{p.id}-{k}", part=pid, measure=min(n_bars - 1, int(qo // bpb)), onset=float(qo),
                                   duration=float(qd), pitch=n.pitch, written=n.pitch - prof.transpose,
                                   src_index=len(snotes) + 1))
    key_name = f"{NOTE_NAMES[tonic]} {mode}"
    sc = Score(title=title or os.path.splitext(os.path.basename(path))[0], parts=score_parts, notes=snotes,
               measures=measures, tempos=[(0.0, round(bpm, 1))],
               source={"format": "band-split", "bpm": round(bpm, 1), "key": key_name, "offset": round(offset, 3),
                       "chords": [{"beat": s["beat"], "label": s["label"]} for s in spans],
                       "chord_part": part_ids.get("keys"),
                       "note": "Automatic band split - check by ear before practising."})

    # ---- files ----
    say("encode", 0.0)
    from .export import write_musicxml
    xml_path = write_musicxml(sc, os.path.join(out_dir, "score.musicxml"))
    stem_dir = os.path.join(out_dir, "stems")
    os.makedirs(stem_dir, exist_ok=True)
    out_parts = []
    for i, p in enumerate(parts):
        f = encode_m4a(p.audio, os.path.join(stem_dir, f"{p.id}.m4a"))
        out_parts.append({"id": p.id, "name": p.name, "instrument": p.instrument, "instrument_name": get_profile(p.instrument).name,
                          "role": p.role,
                          "file": "stems/" + os.path.basename(f), "score_part": part_ids.get(p.id),
                          "activity": p.activity})
        say("encode", (i + 1) / len(parts))
    with open(xml_path, encoding="utf-8") as fh:
        xml = fh.read()
    result = {"title": sc.title, "bpm": round(bpm, 1), "key": key_name, "duration": round(duration, 2),
              "offset": round(offset, 3), "parts": out_parts,
              "chords": [{"beat": s["beat"], "label": s["label"]} for s in spans],
              "score": sc.to_json(), "musicxml": xml}
    with open(os.path.join(out_dir, "split.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)
    say("done", 1.0)
    return result
