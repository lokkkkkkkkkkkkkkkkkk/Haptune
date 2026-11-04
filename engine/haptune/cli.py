"""Command line interface.

    python -m haptune analyze  score.musicxml take.wav --instrument violin --report report.html
    python -m haptune live     score.musicxml take.wav --instrument violin --mode follow
    python -m haptune transcribe recording.mp3 --instrument flute -o melody.musicxml
    python -m haptune omr      sheet.pdf -o sheet.musicxml
    python -m haptune jianpu   song.jianpu.txt -o song.musicxml
    python -m haptune scale    D major --octaves 2 --instrument violin -o d_major.musicxml
    python -m haptune tune     note.wav --instrument guitar
    python -m haptune export-assets ../apple/Shared/Resources
    python -m haptune demo     out_dir
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

from . import dsp


def _load_score(path: str, args):
    from .score import load_score
    sc = load_score(path)
    if getattr(args, "part", None):
        sc = sc.select_parts([args.part])
    return sc


def cmd_analyze(a):
    from .evaluate import evaluate
    from .follower import simulate
    from .report import build_report
    sc = _load_score(a.score, a)
    y = dsp.load_audio(a.audio)
    t0 = time.time()
    ev = evaluate(sc, y, a.instrument, a4=a.a4, target_qpm=a.target_qpm, metronome=a.metronome, level=a.level)
    dt = time.time() - t0
    buzzes = simulate(sc, y, a.instrument, mode="tempo" if a.metronome else "follow",
                      qpm=a.target_qpm, a4=a.a4).buzzed
    print(json.dumps({"scores": ev.scores, "tempo": ev.tempo, "tips": ev.tips,
                      "trouble_spots": ev.trouble_spots, "seconds": round(dt, 2)}, indent=1, ensure_ascii=False))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(ev.to_json(), f, ensure_ascii=False, indent=1)
    if a.report:
        xml = a.score if a.score.lower().endswith((".musicxml", ".xml", ".mxl")) else None
        with open(a.report, "w", encoding="utf-8") as f:
            f.write(build_report(sc, ev, xml, buzzes))
        print("report ->", a.report)


def cmd_live(a):
    from .follower import LiveFollower
    sc = _load_score(a.score, a)
    y = dsp.load_audio(a.audio)
    f = LiveFollower(sc, a.instrument, mode=a.mode, qpm=a.target_qpm, a4=a.a4, sensitivity=a.sensitivity)
    for i in range(0, len(y), 512):
        for ev in f.push(y[i:i + 512]):
            print(json.dumps(ev.to_json(), ensure_ascii=False))
    print(json.dumps({"summary": f.summary()}))


def cmd_transcribe(a):
    from .export import write_musicxml
    from .master_score import recording_to_score
    y = dsp.load_audio(a.audio)
    sc = recording_to_score(y, a.instrument, a4=a.a4, title=a.title or os.path.basename(a.audio),
                            bpm_hint=a.bpm)
    write_musicxml(sc, a.output)
    sc.save_json(os.path.splitext(a.output)[0] + ".json")
    print(json.dumps(sc.source, ensure_ascii=False), "->", a.output)


def cmd_omr(a):
    from .omr import pdf_or_image_to_score
    from .export import write_musicxml
    work = os.path.splitext(a.output)[0] + "_omr"
    sc = pdf_or_image_to_score(a.input, keep_dir=work)
    if sc.source.get("musicxml"):
        import shutil
        shutil.copy(sc.source["musicxml"], a.output)
    else:
        write_musicxml(sc, a.output)
    sc.save_json(os.path.splitext(a.output)[0] + ".json")
    print(f"{len(sc.notes)} notes, {len(sc.measures)} bars recognised -> {a.output}")


def cmd_jianpu(a):
    from .export import write_musicxml
    from .jianpu import parse_jianpu
    with open(a.input, encoding="utf-8") as f:
        sc = parse_jianpu(f.read())
    write_musicxml(sc, a.output)
    sc.save_json(os.path.splitext(a.output)[0] + ".json")
    print(f"{len(sc.notes)} notes -> {a.output}")


def cmd_scale(a):
    from .exercises import scale
    from .export import write_musicxml
    sc = scale(a.tonic, a.kind, a.octaves, a.instrument, qpm=a.qpm)
    write_musicxml(sc, a.output)
    sc.save_json(os.path.splitext(a.output)[0] + ".json")
    print(sc.title, "->", a.output)


def cmd_tune(a):
    from .tuner import tune
    print(json.dumps(tune(dsp.load_audio(a.audio), a.instrument, a.a4)))


def cmd_export_assets(a):
    from .haptics import export_json as hx
    from .instruments import export_json as ix
    os.makedirs(a.out_dir, exist_ok=True)
    ix(os.path.join(a.out_dir, "instruments.json"))
    hx(os.path.join(a.out_dir, "haptics.json"))
    print("wrote instruments.json, haptics.json ->", a.out_dir)


def cmd_demo(a):
    from .demo_pieces import minuet_in_g
    from .evaluate import evaluate
    from .export import write_musicxml
    from .follower import simulate
    from .report import build_report
    from .synth import Mistake, perform
    os.makedirs(a.out_dir, exist_ok=True)
    runs = [
        ("violin", minuet_in_g(), [Mistake(13, "wrong", -1), Mistake(20, "miss"), Mistake(6, "flat", 40),
                                   Mistake(35, "sharp", 35), Mistake(44, "wrong", 2), Mistake(29, "extra", 2)],
         lambda b: 1.18 if 36 <= b < 42 else 1.0),
        ("piano", minuet_in_g(with_bass=True), [Mistake(9, "wrong", -1), Mistake(30, "miss"),
                                                Mistake(51, "wrong", 2)], None),
    ]
    for inst, sc, mistakes, curve in runs:
        perf = perform(sc, inst, mistakes=mistakes, rubato=0.03, seed=21, tempo_curve=curve)
        wav = os.path.join(a.out_dir, f"minuet_{inst}_take.wav")
        dsp.save_audio(wav, perf.audio)
        xml = os.path.join(a.out_dir, f"minuet_{inst}.musicxml")
        write_musicxml(sc, xml)
        ev = evaluate(sc, perf.audio, inst)
        buzzes = simulate(sc, perf.audio, inst).buzzed
        rep = os.path.join(a.out_dir, f"report_minuet_{inst}.html")
        with open(rep, "w", encoding="utf-8") as f:
            f.write(build_report(sc, ev, xml, buzzes, subtitle="demo take with planted mistakes"))
        print(f"{inst}: overall {ev.scores['overall']} | {ev.scores['counts']} | report -> {rep}")


def cmd_split(a):
    from .band import band_split
    from .band_report import build_band_report
    from .score import Score
    instruments = [x for x in (a.instruments or "").split(",") if x.strip()]
    res = band_split(a.audio, a.output, instruments=instruments, title=a.title, backend=a.backend,
                     progress=lambda stage, f: print(f"  {stage:<10} {int(f * 100):3d}%", flush=True))
    page = build_band_report(res, Score.from_json(res["score"]),
                             note="Automatic band split - check rhythms and notes by ear before practising.")
    with open(os.path.join(a.output, "index.html"), "w", encoding="utf-8") as f:
        f.write(page)
    print(f"{len(res['parts'])} parts, {res['key']}, {res['bpm']} BPM -> {a.output}/index.html")


def main(argv=None):
    p = argparse.ArgumentParser(prog="haptune", description="Practice coach engine")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp, score=True):
        if score:
            sp.add_argument("score")
        sp.add_argument("--instrument", "-i", default="piano")
        sp.add_argument("--a4", type=float, default=440.0)
        sp.add_argument("--part", default=None, help="part id to practise (default: all)")

    s = sub.add_parser("analyze"); common(s); s.add_argument("audio")
    s.add_argument("--target-qpm", type=float); s.add_argument("--metronome", action="store_true")
    s.add_argument("--level", default="intermediate"); s.add_argument("--report"); s.add_argument("--json")
    s.set_defaults(fn=cmd_analyze)
    s = sub.add_parser("live"); common(s); s.add_argument("audio")
    s.add_argument("--mode", default="follow", choices=["follow", "wait", "tempo"])
    s.add_argument("--target-qpm", type=float); s.add_argument("--sensitivity", default="normal")
    s.set_defaults(fn=cmd_live)
    s = sub.add_parser("transcribe"); common(s, score=False); s.add_argument("audio")
    s.add_argument("-o", "--output", required=True); s.add_argument("--title"); s.add_argument("--bpm", type=float)
    s.set_defaults(fn=cmd_transcribe)
    s = sub.add_parser("omr"); s.add_argument("input"); s.add_argument("-o", "--output", required=True)
    s.set_defaults(fn=cmd_omr)
    s = sub.add_parser("jianpu"); s.add_argument("input"); s.add_argument("-o", "--output", required=True)
    s.set_defaults(fn=cmd_jianpu)
    s = sub.add_parser("scale"); s.add_argument("tonic"); s.add_argument("kind")
    s.add_argument("--octaves", type=int, default=1); s.add_argument("--instrument", "-i", default="piano")
    s.add_argument("--qpm", type=float, default=80); s.add_argument("-o", "--output", required=True)
    s.set_defaults(fn=cmd_scale)
    s = sub.add_parser("tune"); common(s, score=False); s.add_argument("audio"); s.set_defaults(fn=cmd_tune)
    s = sub.add_parser("export-assets"); s.add_argument("out_dir"); s.set_defaults(fn=cmd_export_assets)
    s = sub.add_parser("demo"); s.add_argument("out_dir"); s.set_defaults(fn=cmd_demo)
    s = sub.add_parser("split", help="band recording -> a part (audio + sheet music) per instrument")
    s.add_argument("audio"); s.add_argument("-o", "--output", required=True)
    s.add_argument("-i", "--instruments", help="who is playing, e.g. voice,violin,keyboard")
    s.add_argument("--title"); s.add_argument("--backend", default="auto", choices=["auto", "mdx", "demucs"])
    s.set_defaults(fn=cmd_split)
    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main(sys.argv[1:])
