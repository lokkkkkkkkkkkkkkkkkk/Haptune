"""PDF -> score through OMR. Skipped when the OMR models are not installed."""
import collections
import importlib.util
import os

import pytest

from haptune.demo_pieces import minuet_in_g

homr_ok = importlib.util.find_spec("homr") is not None


@pytest.mark.skipif(not homr_ok, reason="homr not installed")
def test_pdf_roundtrip(tmp_path):
    import cairosvg
    import fitz
    from haptune.export import musicxml_to_svg_pages, write_musicxml
    from haptune.omr import pdf_or_image_to_score
    sc = minuet_in_g()
    xml = write_musicxml(sc, str(tmp_path / "m.musicxml"))
    pages, _ = musicxml_to_svg_pages(xml)
    doc = fitz.open()
    for i, svg in enumerate(pages):
        p = tmp_path / f"p{i}.pdf"
        cairosvg.svg2pdf(bytestring=svg.encode(), write_to=str(p), output_width=1654, background_color="white")
        doc.insert_pdf(fitz.open(str(p)))
    pdf = str(tmp_path / "m.pdf")
    doc.save(pdf)
    rec = pdf_or_image_to_score(pdf)
    a = collections.Counter((round(n.onset, 2), n.pitch) for n in sc.notes)
    b = collections.Counter((round(n.onset, 2), n.pitch) for n in rec.notes)
    f = 2 * sum((a & b).values()) / (sum(a.values()) + sum(b.values()))
    assert f > 0.9
