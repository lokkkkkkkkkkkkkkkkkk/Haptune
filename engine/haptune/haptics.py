"""Watch feedback vocabulary.

The phone/iPad listens and decides; the Watch only plays haptics and shows a
glyph. This table is the contract between them (exported to the Swift app as
`haptics.json`). `watch_haptic` names are WKHapticType cases on watchOS;
`pattern` is the fallback for custom patterns: a list of (delay_ms, haptic).

Rules that keep feedback useful instead of annoying:
* corrective buzzes are rate-limited (cooldown) and never stacked;
* trend feedback (rushing / dragging) needs 2 of the last 3 notes to agree;
* the metronome lives on the Watch itself, so it is never late and never
  audible (the microphone hears only the player).
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class HapticSpec:
    event: str
    watch_haptic: str          # WKHapticType case name
    pattern: tuple             # ((delay_ms, haptic), ...)
    glyph: str                 # SF Symbol shown on the Watch face
    priority: int              # higher wins when two events collide
    cooldown_ms: int
    description: str


SPECS = {s.event: s for s in [
    HapticSpec("wrong_note", "failure", ((0, "failure"),), "xmark.circle.fill", 5, 700,
               "Wrong pitch: strong double buzz. The Watch shows the note that was expected."),
    HapticSpec("missed_note", "retry", ((0, "retry"),), "arrow.uturn.backward.circle", 4, 900,
               "A note (or chord tone) was skipped."),
    HapticSpec("sharp", "directionUp", ((0, "directionUp"),), "arrow.up.circle", 3, 1200,
               "Sharp: rising tap. Bring the pitch down."),
    HapticSpec("flat", "directionDown", ((0, "directionDown"),), "arrow.down.circle", 3, 1200,
               "Flat: falling tap. Bring the pitch up."),
    HapticSpec("rushing", "stop", ((0, "click"), (120, "click"), (240, "click")), "hare.fill", 2, 2500,
               "Rushing: three quick taps. Hold back."),
    HapticSpec("dragging", "start", ((0, "click"), (350, "click")), "tortoise.fill", 2, 2500,
               "Dragging: two slow taps. Move forward."),
    HapticSpec("section_clean", "success", ((0, "success"),), "checkmark.seal.fill", 1, 0,
               "Loop played cleanly."),
    HapticSpec("count_in", "click", ((0, "click"),), "metronome", 0, 0, "Count-in tick."),
    HapticSpec("beat", "click", ((0, "click"),), "metronome", 0, 0, "Metronome beat (played on the Watch)."),
    HapticSpec("downbeat", "start", ((0, "start"),), "metronome.fill", 0, 0, "Metronome downbeat."),
    HapticSpec("page_turn", "notification", ((0, "notification"),), "doc.text", 0, 0,
               "Score turned the page (optional)."),
]}


@dataclass
class FeedbackEvent:
    type: str
    time: float                 # seconds since the take started
    measure: int | None = None
    measure_label: str | None = None
    note_id: str | None = None
    expected: int | None = None
    played: int | None = None
    cents: float | None = None
    text: str = ""              # short text for the Watch face, e.g. "F#4" or "+24c"

    def to_json(self) -> dict:
        d = asdict(self)
        spec = SPECS.get(self.type)
        if spec:
            d["haptic"] = spec.watch_haptic
            d["glyph"] = spec.glyph
        return {k: v for k, v in d.items() if v is not None}


class HapticGate:
    """Cooldown + priority filter so the wrist is never spammed."""

    def __init__(self, sensitivity: str = "normal"):
        self.last: dict[str, float] = {}
        self.last_any = -1e9
        self.scale = {"gentle": 1.6, "normal": 1.0, "strict": 0.7}.get(sensitivity, 1.0)

    def allow(self, ev: FeedbackEvent) -> bool:
        spec = SPECS.get(ev.type)
        if spec is None or spec.cooldown_ms == 0:
            return True
        cd = spec.cooldown_ms * self.scale / 1000.0
        if ev.time - self.last.get(ev.type, -1e9) < cd:
            return False
        if spec.priority < 5 and ev.time - self.last_any < 0.35:    # never two corrective buzzes in a row
            return False
        self.last[ev.type] = ev.time
        self.last_any = ev.time
        return True


def export_json(path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"schema": "haptune.haptics/1",
                   "events": [dict(asdict(s), pattern=[list(p) for p in s.pattern]) for s in SPECS.values()]},
                  f, indent=1)
