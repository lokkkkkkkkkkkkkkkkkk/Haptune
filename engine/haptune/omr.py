"""Sheet music PDF / photo -> Score, via optical music recognition (OMR).

Uses `homr` (open-source, ONNX models, ~150 MB) page by page and stitches the
pages together. This runs on the server; the phone uploads the PDF.

Honest expectations: clean printed scores (MuseScore / Sibelius / publisher
PDFs) work well for single-staff melodies; dense piano music, handwriting and
skewed phone photos produce errors. The app therefore always shows the
recognised score for a quick check, and offers "import MusicXML instead" for
anyone who has the source file (exact, no recognition needed).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile

from .score import Score, load_musicxml


def render_pdf_pages(pdf_path: str, out_dir: str, dpi: int = 220, max_pages: int = 30) -> list[str]:
    import fitz  # PyMuPDF
    doc = fitz.open(pdf_path)
    paths = []
    for i, page in enumerate(doc):
        if i >= max_pages:
            break
        pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY, alpha=False)
        p = os.path.join(out_dir, f"page_{i + 1:03d}.png")
        pix.save(p)
        paths.append(p)
    return paths


def recognise_image(png_path: str, timeout: int = 600) -> str:
    """Run homr on one page image; returns the path of the MusicXML it wrote."""
    out = os.path.splitext(png_path)[0] + ".musicxml"
    cmd = [sys.executable, "-m", "homr.main", png_path]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0 or not os.path.exists(out):
        raise RuntimeError(f"OMR failed on {os.path.basename(png_path)}: {proc.stderr[-600:]}")
    return out


def merge_pages(xml_paths: list[str], out_path: str, title: str = "") -> str:
    """Concatenate per-page MusicXML files into one score (parts matched by order)."""
    import music21 as m21
    pages = [m21.converter.parse(p) for p in xml_paths]
    base = pages[0]
    for pg in pages[1:]:
        for i, part in enumerate(pg.parts):
            if i >= len(base.parts):
                base.insert(0, part)
                continue
            tgt = base.parts[i]
            last_no = max((m.number for m in tgt.getElementsByClass("Measure")), default=0)
            for k, meas in enumerate(part.getElementsByClass("Measure")):
                meas.number = last_no + k + 1
                tgt.append(meas)
    if title:
        base.metadata = base.metadata or m21.metadata.Metadata()
        base.metadata.title = title
    base.write("musicxml", fp=out_path)
    return out_path


def pdf_or_image_to_score(path: str, dpi: int = 220, keep_dir: str | None = None, **_) -> Score:
    work = keep_dir or tempfile.mkdtemp(prefix="omr_")
    os.makedirs(work, exist_ok=True)
    try:
        if path.lower().endswith(".pdf"):
            images = render_pdf_pages(path, work, dpi)
        else:
            dst = os.path.join(work, "page_001" + os.path.splitext(path)[1].lower())
            shutil.copy(path, dst)
            images = [dst]
        xmls, failed = [], []
        for img in images:
            try:
                xmls.append(recognise_image(img))
            except Exception as e:                  # keep going: one bad page should not lose the rest
                failed.append((os.path.basename(img), str(e)[:200]))
        if not xmls:
            raise RuntimeError(f"No page could be recognised: {failed}")
        merged = os.path.join(work, "recognised.musicxml")
        title = os.path.splitext(os.path.basename(path))[0]
        if len(xmls) == 1:
            shutil.copy(xmls[0], merged)
        else:
            merge_pages(xmls, merged, title)
        sc = load_musicxml(merged)
        sc.title = sc.title or title
        sc.source = {"format": "omr", "pages": len(images), "recognised_pages": len(xmls),
                     "failed_pages": failed, "musicxml": merged if keep_dir else None,
                     "note": "Recognised automatically - please check the notes before practising."}
        return sc
    finally:
        if keep_dir is None:
            shutil.rmtree(work, ignore_errors=True)
