"""Stages Mutopia Project pieces for the free library (then: node tools/import-catalog.mjs <stage dir>).

Mutopia (https://www.mutopiaproject.org, sources on GitHub: MutopiaProject/MutopiaProject) publishes LilyPond
sources, each with a licence in its header. Only Public Domain, CC BY and CC BY-SA pieces are taken; anything
NonCommercial or NoDerivs (or without a licence) is left out. Each piece is compiled to MIDI with LilyPond
(`pip install lilypond`), which the app opens with its MIDI reader. CC BY / BY-SA pieces keep the typesetter's
name and the Mutopia id in their licence line, as those licences ask.

  python3 tools/stage-mutopia.py <MutopiaProject checkout> <stage dir> [--limit N] [--jobs N]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed

import lilypond

LILY = str(lilypond.executable())
BIN = os.path.dirname(LILY)
CONVERT = os.path.join(BIN, "convert-ly")

INSTRUMENTS = {  # Mutopia instrument word -> the app's instrument
    "piano": "piano", "pianoforte": "piano", "fortepiano": "piano", "clavier": "piano", "spinet": "piano", "violine": "violin", "harpsichord": "piano", "clavichord": "piano", "organ": "piano", "keyboard": "piano",
    "guitar": "guitar", "violin": "violin", "flute": "flute", "recorder": "flute", "cello": "cello", "viola": "viola",
    "clarinet": "clarinet", "oboe": "oboe", "voice": "voice", "soprano": "voice", "choir": "voice", "satb": "voice",
    "mezzo-soprano": "voice", "tenor": "voice", "baritone": "voice", "alto": "voice", "bass": "voice",
}
OPEN = [(re.compile(r"public\s*domain", re.I), "Public domain"),
        (re.compile(r"attribution[- ]share\s*alike\s*([\d.]+)", re.I), "CC BY-SA {}"),
        (re.compile(r"attribution\s*([\d.]+)", re.I), "CC BY {}"),
        (re.compile(r"^cc-by-sa$", re.I), "CC BY-SA"), (re.compile(r"^cc-by$", re.I), "CC BY")]
CLOSED = re.compile(r"non\s*-?\s*commercial|no\s*-?\s*deriv|all rights reserved", re.I)


def header(text: str) -> dict:
    out = {}
    for k in ("mutopiatitle", "title", "mutopiacomposer", "composer", "mutopiainstrument", "instrument", "license", "copyright", "style",
              "maintainer", "footer", "date", "opus"):
        m = re.search(rf'^\s*{k}\s*=\s*"((?:[^"\\]|\\.)*)"', text, re.M)
        if m:
            out[k] = m.group(1).strip()
    return out


def licence(h: dict) -> str | None:
    lic = h.get("license") or h.get("copyright") or ""        # older pieces keep it in `copyright`
    if not lic or CLOSED.search(lic):
        return None
    for rx, fmt in OPEN:
        m = rx.search(lic)
        if m:
            return fmt.format(*m.groups())
    return None


def instrument(h: dict) -> str | None:
    words = [w.strip().lower() for w in re.split(r",|&|\band\b|\bor\b|/|\+", h.get("mutopiainstrument") or h.get("instrument") or "") if w.strip()]
    mapped = []
    for w in words:
        w = re.sub(r"\(.*?\)|\bsolo\b|\bduet\b|\d", "", w).strip()
        w = " ".join(x[:-1] if x.endswith("s") and x[:-1] in INSTRUMENTS else x for x in w.split())   # "2 guitars"
        hit = next((v for k, v in INSTRUMENTS.items() if k in w.split() or w == k), None)
        if not hit:
            return None
        if hit not in mapped:
            mapped.append(hit)
    if not mapped or len(mapped) > 2:
        return None                                  # solos and duos only ("harpsichord, piano, clavichord" is one)
    # a song with piano is practised as the voice part; a violin sonata as the violin part
    return next((m for m in mapped if m != "piano"), mapped[0])


def genre(h: dict, inst: str) -> str:
    style, title = (h.get("style") or "").lower(), (h.get("mutopiatitle") or h.get("title") or "").lower()
    if re.search(r"christmas|carol|noël|noel|nativity", title):
        return "christmas"
    if "hymn" in style or re.search(r"\bhymn", title):
        return "hymn"
    if re.search(r"jazz|rag", style) or re.search(r"\brag\b", title):
        return "jazz"
    if re.search(r"folk|traditional", style):
        return "folk"
    if re.search(r"popular|song", style) or inst == "voice":
        return "song"
    if inst == "guitar":
        return "guitar"
    if inst == "piano":
        return "piano"
    return "classical"


def main_files(root: str) -> list[str]:
    out = []
    for d, _, fs in os.walk(os.path.join(root, "ftp")):
        for f in fs:
            if f.endswith(".ly"):
                p = os.path.join(d, f)
                with open(p, encoding="utf-8", errors="replace") as fh:
                    t = fh.read()
                if "mutopiatitle" in t or "footer" in t and "Mutopia-" in t:
                    out.append(p)
    return sorted(out)


def compile_one(path: str, out_dir: str, h: dict) -> list[str]:
    """Compiles a piece (in a scratch copy of its folder) and returns the MIDI files it made."""
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "src")
        shutil.copytree(os.path.dirname(path), src)
        main = os.path.join(src, os.path.basename(path))
        subprocess.run([CONVERT, "-e", "-q", main], cwd=src, capture_output=True, timeout=120)
        text = open(main, encoding="utf-8", errors="replace").read()
        if "\\midi" not in text:                     # no MIDI block: add one to every \layout
            text = re.sub(r"\\layout\s*\{", r"\\midi { } \\layout {", text)
            open(main, "w", encoding="utf-8").write(text)
        r = subprocess.run([LILY, "--loglevel=ERROR", "-dno-print-pages", "-dmidi-extension=mid", "-o", os.path.join(tmp, "out"), main],
                           cwd=src, capture_output=True, timeout=300)
        mids = sorted(f for f in os.listdir(tmp) if f.endswith(".mid"))
        made = []
        key = re.search(r"Mutopia-[\d/]+-(\d+)", h.get("footer", ""))
        base = f"mutopia-{key.group(1) if key else abs(hash(path)) % 10**8}"
        for i, m in enumerate(mids[:6]):
            name = f"{base}{'' if i == 0 else '-' + str(i + 1)}.mid"
            shutil.copy(os.path.join(tmp, m), os.path.join(out_dir, name))
            made.append(name)
        if not made and r.returncode != 0:
            raise RuntimeError(r.stderr.decode("utf-8", "replace")[-300:])
        return made


def stage_one(path: str, out_dir: str):
    text = open(path, encoding="utf-8", errors="replace").read()
    h = header(text)
    lic, inst = licence(h), instrument(h)
    if not lic:
        return ("skip-licence", path, None)
    if not inst:
        return ("skip-instrument", path, None)
    try:
        mids = compile_one(path, out_dir, h)
    except Exception as e:                           # noqa: BLE001 - one bad piece must not stop the batch
        return ("fail", path, str(e)[:200])
    if not mids:
        return ("fail", path, "no MIDI")
    key = re.search(r"Mutopia-[\d/]+-(\d+)", h.get("footer", ""))
    url = f"https://www.mutopiaproject.org/cgibin/piece-info.cgi?id={key.group(1)}" if key else "https://www.mutopiaproject.org"
    title = h.get("mutopiatitle") or h.get("title") or os.path.basename(path)[:-3]
    composer = h.get("composer") or h.get("mutopiacomposer") or ""
    if composer.lower() in ("traditional", "anonymous", "anon."):
        composer = composer.capitalize()
    by = f" · typeset by {h['maintainer']}" if h.get("maintainer") and lic != "Public domain" else ""
    rows = []
    for i, m in enumerate(mids):
        rows.append({"file": m, "title": title if len(mids) == 1 else f"{title} ({i + 1})", "composer": composer,
                     "genre": genre(h, inst), "instrument": inst, "licence": f"{lic} · Mutopia Project{by}", "source": url})
    return ("ok", path, rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("repo"); ap.add_argument("stage")
    ap.add_argument("--limit", type=int, default=0); ap.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    ap.add_argument("--only", default="", help="regex on the path, e.g. 'SorF|GiulianiM'")
    a = ap.parse_args()
    files = main_files(a.repo)
    if a.only:
        files = [f for f in files if re.search(a.only, f)]
    if a.limit:
        files = files[:a.limit]
    os.makedirs(a.stage, exist_ok=True)
    rows, stats = [], {}
    with ProcessPoolExecutor(a.jobs) as ex:
        futs = [ex.submit(stage_one, f, a.stage) for f in files]
        for n, fu in enumerate(as_completed(futs), 1):
            kind, path, data = fu.result()
            stats[kind] = stats.get(kind, 0) + 1
            if kind == "ok":
                rows.extend(data)
            if n % 100 == 0:
                print(f"  {n}/{len(files)} {stats}", file=sys.stderr, flush=True)
    rows.sort(key=lambda r: (r["genre"], r["composer"], r["title"]))
    manifest = {"key": "mutopia", "name": "Mutopia Project", "url": "https://www.mutopiaproject.org",
                "note": "LilyPond sources from github.com/MutopiaProject/MutopiaProject, compiled to MIDI.", "items": rows}
    json.dump(manifest, open(os.path.join(a.stage, "manifest.json"), "w"), ensure_ascii=False, indent=0)
    print(json.dumps(stats), len(rows), "rows", file=sys.stderr)


if __name__ == "__main__":
    main()
