"""Which Claude model reads sheet music well enough for the least money?

Engraves scores whose notes are known (MusicXML), reads the picture back with the AI reader on each model,
and reports notes read exactly, time and cost. Also asks the tutor one question per model. Stops before the
budget (--max-cost, US$) would be passed.

    python engine/tools/model_bench.py --models claude-haiku-5-5,claude-haiku-5-5+claude-opus-5-5,claude-sonnet-5-5 \
        --files engine/samples/minuet_violin.musicxml,engine/samples/minuet_piano.musicxml --max-cost 1.5

A model written "A+B" reads every line with A and re-reads the doubtful bars with B (HAPTUNE_AI_MODEL_READ / _REREAD).
--dry checks everything except the AI (the "reading" is the original score), so it costs nothing.

Needs ANTHROPIC_API_KEY (or a key the network proxy adds) and: music21 verovio cairosvg pymupdf anthropic.
Prices are per million tokens: input, output, cache read, cache write (from the Claude API price list).
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(HERE, "..", "tests"))

PRICES = {"claude-opus-5-5": (4.0, 20.0, 0.20, 5.0), "claude-sonnet-5-5": (2.0, 10.0, 0.20, 2.5), "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125)}


def cost(model: str, u: dict) -> float:
    p = PRICES.get(model, PRICES["claude-opus-5-5"])
    return (u["input_tokens"] * p[0] + u["output_tokens"] * p[1] + u["cache_read_tokens"] * p[2] + u["cache_write_tokens"] * p[3]) / 1e6


def note_tokens(bars) -> list[str]:
    return [tok for bar in bars for part in bar for voice in part for tok in voice.split() if tok and not tok.startswith("r") and tok != "R"]


def compare(expected, got) -> tuple[int, int]:
    """Notes read exactly (pitch, accidental, length, tie), in order, of the expected notes."""
    e, g = note_tokens(expected), note_tokens(got)
    sm = difflib.SequenceMatcher(a=e, b=g, autojunk=False)
    return sum(b.size for b in sm.get_matching_blocks()), len(e)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="claude-haiku-5-5,claude-sonnet-5-5")
    ap.add_argument("--files", default=",".join(os.path.join(HERE, "..", "samples", f) for f in ("minuet_violin.musicxml", "minuet_piano.musicxml")))
    ap.add_argument("--max-cost", type=float, default=1.5)
    ap.add_argument("--tutor", action="store_true", help="also ask the tutor one question per model")
    ap.add_argument("--dry", action="store_true", help="no AI: check the pipeline with the original score as the reading")
    a = ap.parse_args()
    from ai_fixtures import render_pdf, score_to_bars
    from haptune.ai.claude import Claude
    from haptune.ai.reader import Hints, Reader
    spent, rows = 0.0, []
    for model in a.models.split(","):
        for path in a.files.split(","):
            if spent >= a.max_cost:
                print(f"budget reached (${spent:.2f}); stopping")
                break
            expected, meta = score_to_bars(path)
            pdf = render_pdf(path, bars_per_line=4)
            first, _, again = model.partition("+")
            ai = Claude(model=first)
            ai2 = Claude(model=again) if again else None
            t0 = time.time()
            try:
                if a.dry:
                    xml_text, n_flags = open(path, encoding="utf-8").read(), 0
                else:
                    res = Reader(ai=ai, max_pages=1, reread_ai=ai2).read([(pdf, os.path.basename(path).replace(".musicxml", ".pdf"))], "",
                                                                         Hints(instrument="piano" if "piano" in path else "violin"))
                    xml_text, n_flags = res.musicxml, len(res.flags)
                with tempfile.NamedTemporaryFile("w", suffix=".musicxml", delete=False, encoding="utf-8") as f:
                    f.write(xml_text)
                got, _ = score_to_bars(f.name)
                ok, total = compare(expected, got)
                flagged = n_flags
                err = ""
            except Exception as e:                                   # report it and carry on with the next model
                ok, total, flagged, err = 0, len(note_tokens(expected)), 0, f"{type(e).__name__}: {e}"[:160]
            u = ai.usage.to_json()
            c = cost(first, u) + (cost(again, ai2.usage.to_json()) if ai2 else 0.0)
            spent += c
            rows.append({"model": model, "file": os.path.basename(path), "notes_exact": ok, "notes": total, "bars_flagged": flagged,
                         "seconds": round(time.time() - t0, 1), "cost_usd": round(c, 4), "calls": u["calls"], "error": err})
            print(json.dumps(rows[-1]))
        if a.tutor and not a.dry and "+" not in model and spent < a.max_cost:
            ai = Claude(model=model)
            t0 = time.time()
            ans = ai.ask_text("You are Hapi, a friendly music tutor. Answer in under 120 words, plain text.",
                              "The student plays violin, level 2. Question: how do I stop my bow from squeaking?", effort="low", max_tokens=2000)
            c = cost(model, ai.usage.to_json())
            spent += c
            print(json.dumps({"model": model, "tutor_seconds": round(time.time() - t0, 1), "tutor_cost_usd": round(c, 5), "answer": ans[:300]}))
    print(f"total spent: ${spent:.3f}")


if __name__ == "__main__":
    main()
