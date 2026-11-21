"""Stages the whole OpenScore Lieder Corpus for the free library (then: node tools/import-catalog.mjs <stage dir>).

OpenScore Lieder (https://github.com/OpenScore/Lieder) is a CC0 collection of 19th-century art songs, transcribed
from public-domain scores on IMSLP. The library already holds the songs that also appear in When-in-Rome (key
"lieder"); this adds the rest. MuseScore (3.6, run headless under Xvfb) converts each .mscx to compressed MusicXML
in one batch job.

  python3 tools/stage-openscore-lieder.py <Lieder checkout> <stage dir> <mscore> [--existing assets/catalog/index.json]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import unicodedata
import xml.etree.ElementTree as ET


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def meta(path: str) -> dict:
    out = {}
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError:
        return out
    for mt in root.iter("metaTag"):
        name = mt.get("name")
        if name and mt.text:
            out[name] = mt.text.strip()
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("lieder")
    ap.add_argument("stage")
    ap.add_argument("mscore")
    ap.add_argument("--existing", default=os.path.join(os.path.dirname(__file__), "..", "assets", "catalog", "index.json"))
    a = ap.parse_args()
    os.makedirs(a.stage, exist_ok=True)
    have = set()
    if os.path.exists(a.existing):
        idx = json.load(open(a.existing, encoding="utf-8"))
        for r in idx["items"]:
            if str(r[0]).startswith("lieder-"):
                have.add((norm(r[1]), norm(r[2]).split(" ")[-1]))
    jobs, items = [], []
    for dirpath, _, files in os.walk(os.path.join(a.lieder, "scores")):
        for f in sorted(files):
            if not f.endswith(".mscx"):
                continue
            src = os.path.join(dirpath, f)
            m = meta(src)
            rel = os.path.relpath(dirpath, os.path.join(a.lieder, "scores")).split(os.sep)
            composer = m.get("composer") or rel[0].replace("_", " ")
            if "," in composer:                                         # "Brahms, Johannes" -> "Johannes Brahms"
                last, first = [x.strip() for x in composer.split(",", 1)]
                composer = f"{first} {last}".strip()
            title = m.get("workTitle") or rel[-1].replace("_", " ")
            set_title = rel[1].replace("_", " ") if len(rel) > 2 and rel[1] != "_" else ""
            if set_title and title.lower() not in set_title.lower():
                title = f"{title} ({set_title})"
            if (norm(m.get("workTitle") or rel[-1].replace("_", " ")), norm(composer).split(" ")[-1]) in have:
                continue
            out = f"{len(items) + 1:04d}.mxl"
            jobs.append({"in": os.path.abspath(src), "out": os.path.abspath(os.path.join(a.stage, out))})
            items.append({"file": out, "title": title, "composer": composer, "genre": "song", "instrument": "voice",
                          "licence": "CC0 · OpenScore Lieder Corpus",
                          "source": "https://github.com/OpenScore/Lieder/tree/main/scores/" + "/".join(rel)})
    job = os.path.join(a.stage, "_job.json")
    json.dump(jobs, open(job, "w"))
    print(f"{len(items)} songs to convert ({len(have)} already in the library)", flush=True)
    subprocess.run(["xvfb-run", "-a", a.mscore, "-j", job], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = [it for it in items if os.path.exists(os.path.join(a.stage, it["file"]))]
    os.remove(job)
    json.dump({"key": "openscore-lieder", "name": "OpenScore Lieder Corpus (more songs)", "url": "https://github.com/OpenScore/Lieder",
               "note": "CC0 (public domain dedication). Transcribed from public-domain scores on IMSLP.", "items": ok},
              open(os.path.join(a.stage, "manifest.json"), "w"), ensure_ascii=False, indent=1)
    print(f"{len(ok)} converted", file=sys.stderr)


if __name__ == "__main__":
    main()
