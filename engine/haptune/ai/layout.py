"""Pages -> images, then staves and systems found on each page, so each system can be read zoomed in.

Printed music has long, perfectly horizontal staff lines, so a row-darkness profile finds them reliably
after a small deskew. Five evenly spaced lines make a staff; staves joined at the left edge (by the
system barline or a brace) make a system. Anything that does not look like printed staves (a dark or
curved phone photo) falls back to reading the whole page.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageOps

MAX_EDGE = 2576            # the vision model's maximum useful long edge


@dataclass
class Staff:
    top: float
    bottom: float
    space: float
    x0: int
    x1: int
    lines: list[float] = field(default_factory=list)


@dataclass
class System:
    index: int
    staves: list[Staff]
    box: tuple[int, int, int, int]          # x0, y0, x1, y1 in page pixels


@dataclass
class Page:
    index: int
    image: Image.Image                       # grayscale, deskewed
    systems: list[System]
    skew: float = 0.0

    @property
    def size(self) -> tuple[int, int]:
        return self.image.size


def load_pages(path_or_bytes, filename: str = "", max_pages: int = 20, target_width: int = 2400) -> list[Image.Image]:
    """Renders PDF pages (or loads one photo) as grayscale images about `target_width` pixels wide."""
    data = path_or_bytes if isinstance(path_or_bytes, (bytes, bytearray)) else open(path_or_bytes, "rb").read()
    name = (filename or (path_or_bytes if isinstance(path_or_bytes, str) else "")).lower()
    if name.endswith(".pdf") or data[:5] == b"%PDF-":
        import pymupdf
        doc = pymupdf.open(stream=data, filetype="pdf")
        out = []
        for i, page in enumerate(doc):
            if i >= max_pages:
                break
            zoom = min(4.0, max(1.0, target_width / max(1.0, page.rect.width)))
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csGRAY, alpha=False)
            out.append(Image.frombytes("L", (pix.width, pix.height), pix.samples))
        return out
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("L")
    if img.width > 3400:
        img = img.resize((3000, round(img.height * 3000 / img.width)), Image.LANCZOS)
    return [img]


def _otsu(a: np.ndarray) -> int:
    hist = np.bincount(a.ravel(), minlength=256).astype(np.float64)
    total = hist.sum()
    if total == 0:
        return 128
    sum_all = np.dot(np.arange(256), hist)
    w0 = np.cumsum(hist)
    s0 = np.cumsum(hist * np.arange(256))
    w1 = total - w0
    with np.errstate(divide="ignore", invalid="ignore"):
        between = (s0 * total - w0 * sum_all) ** 2 / (w0 * w1)
    between[~np.isfinite(between)] = 0
    return int(np.argmax(between))


def binarize(img: Image.Image) -> np.ndarray:
    a = np.asarray(img, dtype=np.uint8)
    # photos: flatten uneven lighting by dividing by a blurred background
    if a.std() > 0 and np.percentile(a, 90) < 235:
        from PIL import ImageFilter
        bg = np.asarray(img.filter(ImageFilter.GaussianBlur(radius=max(8, img.width // 60))), dtype=np.float32)
        a = np.clip(a.astype(np.float32) / np.maximum(bg, 1) * 255, 0, 255).astype(np.uint8)
    thr = min(185, max(90, _otsu(a)))
    return a < thr


def estimate_skew(dark: np.ndarray, max_deg: float = 4.0) -> float:
    """The rotation (degrees) that makes staff lines horizontal, from a downscaled copy."""
    h, w = dark.shape
    scale = min(1.0, 900 / max(w, 1))
    small = Image.fromarray((dark * 255).astype(np.uint8)).resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.BILINEAR)
    best, best_score = 0.0, -1.0
    for deg in np.arange(-max_deg, max_deg + 0.01, 0.25):
        r = np.asarray(small.rotate(float(deg), resample=Image.BILINEAR, fillcolor=0), dtype=np.float32)
        prof = r.sum(axis=1)
        score = float((prof ** 2).sum())
        if score > best_score:
            best, best_score = float(deg), score
    return best


def _lines(dark: np.ndarray) -> list[tuple[float, int]]:
    """Candidate staff-line rows: (y centre, thickness)."""
    h, w = dark.shape
    prof = dark.sum(axis=1) / max(1, w)
    top = float(np.percentile(prof, 99.5))
    thr = max(0.22, 0.5 * top)
    cand = prof > thr
    out, y = [], 0
    while y < h:
        if cand[y]:
            y0 = y
            while y < h and cand[y]:
                y += 1
            out.append(((y0 + y - 1) / 2.0, y - y0))
        else:
            y += 1
    return out


def find_staves(dark: np.ndarray) -> list[Staff]:
    lines = _lines(dark)
    staves: list[Staff] = []
    i = 0
    while i + 4 < len(lines):
        ys = [lines[i + k][0] for k in range(5)]
        gaps = np.diff(ys)
        med = float(np.median(gaps))
        if med >= 4 and all(0.72 * med <= g <= 1.35 * med for g in gaps):
            rows = [int(round(y)) for y in ys]
            cols = np.zeros(dark.shape[1], dtype=np.int32)
            for r in rows:
                band = dark[max(0, r - 1):r + 2].any(axis=0)
                cols += band
            on = np.where(cols >= 4)[0]
            if len(on):
                x0, x1 = int(on[0]), int(on[-1])
                staves.append(Staff(top=ys[0], bottom=ys[4], space=med, x0=x0, x1=x1, lines=ys))
                i += 5
                continue
        i += 1
    return staves


def _connected(dark: np.ndarray, a: Staff, b: Staff) -> bool:
    """True if staff a and staff b (below it) are joined at the left by a barline or brace."""
    x = min(a.x0, b.x0)
    sp = (a.space + b.space) / 2
    x_lo, x_hi = max(0, int(x - 2.5 * sp)), min(dark.shape[1], int(x + 0.6 * sp) + 1)
    y_lo, y_hi = int(a.bottom) + 2, int(b.top) - 1
    if y_hi <= y_lo:
        return True
    band = dark[y_lo:y_hi, x_lo:x_hi]
    if band.size == 0:
        return False
    return float(band.any(axis=1).mean()) >= 0.85


def find_systems(dark: np.ndarray) -> list[System]:
    staves = find_staves(dark)
    if not staves:
        return []
    groups: list[list[Staff]] = [[staves[0]]]
    for s in staves[1:]:
        if _connected(dark, groups[-1][-1], s):
            groups[-1].append(s)
        else:
            groups.append([s])
    h, w = dark.shape
    systems = []
    for gi, g in enumerate(groups):
        sp = float(np.median([s.space for s in g]))
        y0 = g[0].top - 5.0 * sp
        y1 = g[-1].bottom + 5.0 * sp
        if gi > 0:
            prev_bottom = groups[gi - 1][-1].bottom
            y0 = max(y0, (prev_bottom + g[0].top) / 2 - 0.5 * sp)
        if gi + 1 < len(groups):
            nxt_top = groups[gi + 1][0].top
            y1 = min(y1, (g[-1].bottom + nxt_top) / 2 + 0.5 * sp)
        x0 = min(s.x0 for s in g) - 3.5 * sp
        x1 = max(s.x1 for s in g) + 1.5 * sp
        box = (max(0, int(x0)), max(0, int(y0)), min(w, int(x1)), min(h, int(y1)))
        systems.append(System(index=gi, staves=g, box=box))
    return systems


def analyse_page(img: Image.Image, index: int = 0) -> Page:
    dark = binarize(img)
    skew = estimate_skew(dark)
    if abs(skew) >= 0.25:
        img = img.rotate(skew, resample=Image.BICUBIC, expand=False, fillcolor=255)
        dark = binarize(img)
    systems = find_systems(dark)
    # sanity: systems should have consistent staff counts on printed music
    return Page(index=index, image=img, systems=systems, skew=skew)


def encode_png(img: Image.Image, max_edge: int = MAX_EDGE, min_space: float | None = None, space: float | None = None) -> bytes:
    """PNG for the model: scaled so a staff space is at least `min_space` px (when known), never past max_edge."""
    w, h = img.size
    scale = 1.0
    if min_space and space and space < min_space:
        scale = min_space / space
    scale = min(scale, max_edge / max(w, h))
    if abs(scale - 1.0) > 0.02:
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def crop(img: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    return img.crop(box)
