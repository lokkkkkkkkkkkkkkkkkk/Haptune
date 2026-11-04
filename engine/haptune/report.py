"""Self-contained HTML practice report: coloured sheet music, bar heat-map,
piano-roll of what you played vs the score, tempo and intonation charts,
Watch buzz timeline, tips and the practice plan.

The same views exist natively in the iPhone app (Swift Charts); this file is
used by the server, the CLI and for sharing a take with a teacher.
"""
from __future__ import annotations

import html
import json
import re
from collections import defaultdict

from .evaluate import Evaluation
from .instruments import get_profile
from .score import Score, midi_name

STATUS_STYLE = {   # colour, icon, label  (status colours never carry meaning alone: icon + label)
    "correct": ("var(--ink-2)", "", "Correct"),
    "wrong": ("var(--critical)", "✕", "Wrong note"),
    "missed": ("var(--serious)", "○", "Missed"),
    "uncertain": ("var(--ink-3)", "?", "Not judged"),
    "sharp": ("var(--sharp)", "↑", "Sharp"),
    "flat": ("var(--flat)", "↓", "Flat"),
    "timing": ("var(--warning)", "◆", "Early / late"),
}

CSS = """
:root{
  --surface:#fcfcfb;--surface-2:#f3f2ef;--ink:#0b0b0b;--ink-2:#52514e;--ink-3:#8a8984;--grid:#e4e2dc;
  --critical:#d03b3b;--serious:#ec835a;--warning:#c98500;--good:#0ca30c;--flat:#2a78d6;--sharp:#6250d6;
  --accent:#2a78d6;--heat-0:#fcfcfb;--heat-1:#fbe3d6;--heat-2:#f6bf9f;--heat-3:#ee9467;--heat-4:#d95926;
  color-scheme:light}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --surface:#1a1a19;--surface-2:#242422;--ink:#f0efec;--ink-2:#c3c2b7;--ink-3:#8f8e86;--grid:#34332f;
  --critical:#e66767;--serious:#ec835a;--warning:#fab219;--good:#0ca30c;--flat:#3987e5;--sharp:#9085e9;
  --accent:#3987e5;--heat-0:#1a1a19;--heat-1:#3a271d;--heat-2:#6a3a22;--heat-3:#a24c22;--heat-4:#d95926;color-scheme:dark}}
:root[data-theme="dark"]{--surface:#1a1a19;--surface-2:#242422;--ink:#f0efec;--ink-2:#c3c2b7;--ink-3:#8f8e86;
  --grid:#34332f;--critical:#e66767;--serious:#ec835a;--warning:#fab219;--flat:#3987e5;--sharp:#9085e9;
  --accent:#3987e5;--heat-0:#1a1a19;--heat-1:#3a271d;--heat-2:#6a3a22;--heat-3:#a24c22;--heat-4:#d95926;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:26px;margin:0 0 2px}h2{font-size:17px;margin:34px 0 10px}
.sub{color:var(--ink-2);margin:0 0 18px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.tile{background:var(--surface-2);border-radius:14px;padding:14px 16px}
.tile .k{color:var(--ink-2);font-size:13px}.tile .v{font-size:34px;font-weight:650;letter-spacing:-.5px}
.tile .d{color:var(--ink-2);font-size:13px}
.card{background:var(--surface-2);border-radius:14px;padding:14px;overflow:hidden}
.sheet svg{width:100%;height:auto;background:#fff;border-radius:10px}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin:10px 0 0;color:var(--ink-2);font-size:13px}
.legend span b{display:inline-block;width:18px;text-align:center;font-weight:700}
.heat{display:flex;flex-wrap:wrap;gap:2px}
.heat div{flex:1 0 34px;min-width:34px;height:46px;border-radius:6px;display:flex;align-items:flex-end;
  justify-content:center;font-size:12px;color:var(--ink);padding-bottom:3px;cursor:default}
svg text{fill:var(--ink-2);font-size:11px}
.chart{width:100%;height:auto;display:block}
.tip{margin:6px 0;padding:10px 12px;border-left:3px solid var(--accent);background:var(--surface-2);border-radius:6px}
.plan{display:grid;gap:10px}
.step{display:flex;gap:10px;align-items:baseline}.step b{min-width:76px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:5px 8px;border-bottom:1px solid var(--grid);text-align:left}
#tt{position:fixed;pointer-events:none;background:var(--ink);color:var(--surface);padding:6px 9px;border-radius:8px;
  font-size:12px;opacity:0;transition:opacity .08s;max-width:260px;z-index:9}
details summary{cursor:pointer;color:var(--ink-2)}
.note{color:var(--ink-3);font-size:12px;margin-top:28px}
"""

JS = """
const tt=document.getElementById('tt');
document.querySelectorAll('[data-tip]').forEach(el=>{
  el.addEventListener('mousemove',e=>{tt.textContent=el.dataset.tip;tt.style.opacity=1;
    const x=Math.min(e.clientX+14,innerWidth-280);tt.style.left=x+'px';tt.style.top=(e.clientY+14)+'px'});
  el.addEventListener('mouseleave',()=>tt.style.opacity=0);
});
"""


def _esc(s) -> str:
    return html.escape(str(s), quote=True)


def _note_category(r) -> str:
    if r.status in ("wrong", "missed", "uncertain"):
        return r.status
    if r.intonation and "sharp" in r.intonation:
        return "sharp"
    if r.intonation and "flat" in r.intonation:
        return "flat"
    if r.timing and r.timing != "ok":
        return "timing"
    return "correct"


# ---------------------------------------------------------------------------
# Sheet music colouring with Verovio
# ---------------------------------------------------------------------------
def _coloured_sheet(score: Score, ev: Evaluation, musicxml: str | None) -> str:
    try:
        from .export import musicxml_to_svg_pages, write_musicxml
        import tempfile
        import os
        if musicxml is None:
            fd, musicxml = tempfile.mkstemp(suffix=".musicxml")
            os.close(fd)
            write_musicxml(score, musicxml)
        with open(musicxml, encoding="utf-8", errors="replace") as f:
            data = f.read()
        data = re.sub(r"<metronome[^>]*>.*?</metronome>", "", data, flags=re.S)   # tempo glyph: not needed here
        pages, tk = musicxml_to_svg_pages(data, page_width=2100, scale=38)
    except Exception as e:                                     # rendering is optional
        return f"<p class='sub'>Sheet music preview unavailable ({_esc(e)}).</p>"
    # printed position of each performed note (repeats collapse onto the printed bar)
    printed_start: dict[int, float] = {}
    pos = 0.0
    for m in sorted({m.src: m for m in score.measures}.values(), key=lambda m: m.src):
        printed_start[m.src] = pos
        pos += m.duration
    by_id = {r.note_id: r for r in ev.notes}
    severity = {"wrong": 5, "missed": 4, "sharp": 3, "flat": 3, "timing": 2, "uncertain": 1, "correct": 0}
    want: dict[tuple, str] = {}
    for n in score.playable_notes():
        r = by_id.get(n.id)
        if r is None or n.pitch is None:
            continue
        m = score.measures[n.measure]
        q = round(printed_start.get(m.src, m.start) + (n.onset - m.start), 3)
        cat = _note_category(r)
        for p in {n.pitch, n.written}:
            if p is None:
                continue
            k = (q, p)
            if severity[cat] >= severity.get(want.get(k, "correct"), 0):
                want[k] = cat
    css = []
    try:
        tmap = json.loads(tk.renderToTimemap()) if isinstance(tk.renderToTimemap(), str) else tk.renderToTimemap()
    except Exception:
        tmap = []
    for entry in tmap:
        q = round(float(entry.get("qstamp", 0)), 3)
        for nid in entry.get("on", []):
            try:
                mv = tk.getMIDIValuesForElement(nid)
                mv = json.loads(mv) if isinstance(mv, str) else mv
                pitch = int(mv.get("pitch"))
            except Exception:
                continue
            cat = want.get((q, pitch))
            if cat and cat != "correct":
                color = STATUS_STYLE[cat][0]
                css.append(f"g#{nid} .notehead, g#{nid} .accid{{fill:{color}}}")
    style = "<style>" + "".join(css) + "</style>"
    return style + "".join(f"<div class='sheet'>{p}</div>" for p in pages)


# ---------------------------------------------------------------------------
# Charts (hand-built SVG, hover tooltips via data-tip)
# ---------------------------------------------------------------------------
def _heat(score: Score, ev: Evaluation) -> str:
    cells = []
    for m in ev.measures:
        bad = 100 - m.score
        lvl = 0 if bad < 5 else 1 if bad < 15 else 2 if bad < 30 else 3 if bad < 50 else 4
        parts = []
        if m.wrong:
            parts.append(f"{m.wrong} wrong")
        if m.missed:
            parts.append(f"{m.missed} missed")
        if m.extra:
            parts.append(f"{m.extra} extra")
        if m.timing_issues:
            parts.append(f"{m.timing_issues} timing")
        if m.intonation_issues:
            parts.append(f"{m.intonation_issues} out of tune")
        tempo = f" · {m.tempo_qpm:.0f} BPM" if m.tempo_qpm else ""
        tip = f"Bar {m.label}: {m.score:.0f}/100" + (" — " + ", ".join(parts) if parts else " — clean") + tempo
        cells.append(f"<div style='background:var(--heat-{lvl})' data-tip='{_esc(tip)}'>{_esc(m.label)}</div>")
    legend = ("<div class='legend'><span>Bar colour = how much needs work:</span>"
              + "".join(f"<span><b style='background:var(--heat-{i});border-radius:4px'>&nbsp;</b> {t}</span>"
                        for i, t in enumerate(["clean", "minor", "some", "many", "most"])) + "</div>")
    return f"<div class='card'><div class='heat'>{''.join(cells)}</div>{legend}</div>"


def _pianoroll(score: Score, ev: Evaluation, buzzes: list | None) -> str:
    rows = [r for r in ev.notes if r.expected is not None]
    if not rows:
        return ""
    times = [t for r in rows for t in (r.time, r.expected_time) if t is not None]
    times += [d.onset for d in ev.detected]
    t0, t1 = (min(times), max(times)) if times else (0, 1)
    t1 = max(t1 + 0.6, t0 + 1)
    ps = [r.expected for r in rows] + [r.played for r in rows if r.played is not None]
    p0, p1 = min(ps) - 2, max(ps) + 2
    W, H, L, T, B = 1040, max(220, (p1 - p0) * 9 + 70), 44, 34, 28
    x = lambda t: L + (t - t0) / (t1 - t0) * (W - L - 10)          # noqa: E731
    y = lambda p: T + (p1 - p) / (p1 - p0) * (H - T - B)           # noqa: E731
    rowh = max(4.0, (H - T - B) / (p1 - p0) * 0.8)
    out = [f"<svg class='chart' viewBox='0 0 {W} {H}' role='img' aria-label='What you played compared with the score'>"]
    for p in range(p0, p1 + 1):
        if p % 12 == 0:
            out.append(f"<line x1='{L}' x2='{W - 10}' y1='{y(p):.1f}' y2='{y(p):.1f}' stroke='var(--grid)'/>"
                       f"<text x='{L - 6}' y='{y(p) + 4:.1f}' text-anchor='end'>{midi_name(p)}</text>")
    step = 5 if t1 - t0 > 40 else 2 if t1 - t0 > 12 else 1
    t = int(t0)
    while t <= t1:
        out.append(f"<text x='{x(t):.1f}' y='{H - 8}' text-anchor='middle'>{t}s</text>")
        t += step
    # expected notes: outlined ghost bars at the time the player's own tempo predicts
    spb = 60.0 / (ev.tempo.get("average_qpm") or score.first_tempo)
    for r in rows:
        if r.expected_time is None:
            continue
        n_dur = next((n.duration for n in score.notes if n.id == r.note_id), 1.0) * spb
        out.append(f"<rect x='{x(r.expected_time):.1f}' y='{y(r.expected) - rowh / 2:.1f}' width='{max(3, x(r.expected_time + n_dur) - x(r.expected_time) - 2):.1f}' "
                   f"height='{rowh:.1f}' rx='2' fill='none' stroke='var(--ink-3)' stroke-width='1' stroke-dasharray='3 2'/>")
    for r in rows:
        if r.time is None or r.played is None:
            continue
        cat = _note_category(r)
        color = STATUS_STYLE[cat][0] if cat != "correct" else "var(--accent)"
        n_dur = next((n.duration for n in score.notes if n.id == r.note_id), 1.0) * spb
        tip = (f"Bar {score.measures[r.measure].label}: {STATUS_STYLE[cat][2]} — expected {midi_name(r.expected)}, "
               f"played {midi_name(r.played)}"
               + (f", {r.timing_ms:+.0f} ms" if r.timing_ms is not None else "")
               + (f", {r.cents:+.0f} cents" if r.cents is not None else ""))
        out.append(f"<rect x='{x(r.time):.1f}' y='{y(r.played) - rowh / 2:.1f}' width='{max(3, x(r.time + n_dur) - x(r.time) - 2):.1f}' "
                   f"height='{rowh:.1f}' rx='2' fill='{color}' data-tip='{_esc(tip)}'/>")
    for e in ev.extras:
        if e.played is None:
            continue
        out.append(f"<rect x='{x(e.time):.1f}' y='{y(e.played) - rowh / 2:.1f}' width='8' height='{rowh:.1f}' rx='2' "
                   f"fill='var(--critical)' opacity='.55' data-tip='Extra note {midi_name(e.played)} at {e.time:.2f}s'/>")
    # Watch buzz lane
    if buzzes:
        out.append(f"<text x='{L - 6}' y='{T - 14}' text-anchor='end'>Watch</text>")
        sym = {"wrong_note": ("✕", "var(--critical)"), "missed_note": ("○", "var(--serious)"),
               "sharp": ("↑", "var(--sharp)"), "flat": ("↓", "var(--flat)"), "rushing": ("»", "var(--warning)"),
               "dragging": ("«", "var(--warning)"), "section_clean": ("✓", "var(--good)")}
        for b in buzzes:
            s, c = sym.get(b.type, ("•", "var(--ink-2)"))
            label = b.type.replace("_", " ")
            out.append(f"<g data-tip='{_esc(f'{b.time:.2f}s · Watch buzz: {label} {b.text}'.strip())}'>"
                       f"<circle cx='{x(b.time):.1f}' cy='{T - 18}' r='8' fill='{c}'/>"
                       f"<text x='{x(b.time):.1f}' y='{T - 14}' text-anchor='middle' style='fill:var(--surface);font-weight:700'>{s}</text></g>")
    out.append("</svg>")
    legend = ("<div class='legend'><span><b style='color:var(--accent)'>▬</b> played (correct)</span>"
              "<span><b style='color:var(--ink-3)'>┅</b> where the score expected it</span>"
              + "".join(f"<span><b style='color:{STATUS_STYLE[k][0]}'>{STATUS_STYLE[k][1] or '▬'}</b> {STATUS_STYLE[k][2]}</span>"
                        for k in ("wrong", "missed", "sharp", "flat", "timing")) + "</div>")
    return f"<div class='card'>{''.join(out)}{legend}</div>"


def _tempo_chart(ev: Evaluation) -> str:
    pts = [(m.index, m.label, m.tempo_qpm) for m in ev.measures if m.tempo_qpm]
    if len(pts) < 2:
        return ""
    W, H, L, T, B = 1040, 200, 44, 14, 26
    lo = min(v for _, _, v in pts) * 0.9
    hi = max(v for _, _, v in pts) * 1.1
    tgt = ev.tempo.get("target_qpm")
    if tgt:
        lo, hi = min(lo, tgt * 0.9), max(hi, tgt * 1.1)
    i0, i1 = pts[0][0], pts[-1][0]
    x = lambda i: L + (i - i0) / max(1, i1 - i0) * (W - L - 14)    # noqa: E731
    y = lambda v: T + (hi - v) / (hi - lo) * (H - T - B)           # noqa: E731
    out = [f"<svg class='chart' viewBox='0 0 {W} {H}' role='img' aria-label='Tempo by bar'>"]
    for v in range(int(lo // 10 * 10), int(hi) + 1, 10):
        if lo <= v <= hi:
            out.append(f"<line x1='{L}' x2='{W - 14}' y1='{y(v):.1f}' y2='{y(v):.1f}' stroke='var(--grid)'/>"
                       f"<text x='{L - 6}' y='{y(v) + 4:.1f}' text-anchor='end'>{v}</text>")
    avg = ev.tempo.get("average_qpm")
    if avg:
        out.append(f"<line x1='{L}' x2='{W - 14}' y1='{y(avg):.1f}' y2='{y(avg):.1f}' stroke='var(--ink-3)' stroke-dasharray='4 3'/>"
                   f"<text x='{W - 16}' y='{y(avg) - 5:.1f}' text-anchor='end'>your average {avg:.0f}</text>")
    path = " ".join(f"{'M' if k == 0 else 'L'}{x(i):.1f},{y(v):.1f}" for k, (i, _, v) in enumerate(pts))
    out.append(f"<path d='{path}' fill='none' stroke='var(--accent)' stroke-width='2' stroke-linejoin='round'/>")
    for i, lab, v in pts:
        out.append(f"<circle cx='{x(i):.1f}' cy='{y(v):.1f}' r='9' fill='transparent' data-tip='Bar {_esc(lab)}: {v:.0f} BPM'/>"
                   f"<circle cx='{x(i):.1f}' cy='{y(v):.1f}' r='3' fill='var(--accent)' pointer-events='none'/>")
    step = max(1, len(pts) // 16)
    for k, (i, lab, _) in enumerate(pts):
        if k % step == 0:
            out.append(f"<text x='{x(i):.1f}' y='{H - 8}' text-anchor='middle'>{_esc(lab)}</text>")
    out.append("</svg>")
    return f"<div class='card'>{''.join(out)}<div class='legend'><span>Tempo (quarter-note BPM) per bar</span></div></div>"


def _intonation_chart(ev: Evaluation, prof) -> str:
    pts = [r for r in ev.notes if r.cents is not None and r.time is not None]
    if len(pts) < 3:
        return ""
    W, H, L, T, B = 1040, 220, 44, 14, 26
    lim = max(50.0, max(abs(r.cents) for r in pts) * 1.15)
    t0, t1 = min(r.time for r in pts), max(r.time for r in pts) + 0.1
    x = lambda t: L + (t - t0) / max(0.1, t1 - t0) * (W - L - 14)  # noqa: E731
    y = lambda c: T + (lim - c) / (2 * lim) * (H - T - B)          # noqa: E731
    out = [f"<svg class='chart' viewBox='0 0 {W} {H}' role='img' aria-label='Intonation per note in cents'>"]
    out.append(f"<rect x='{L}' y='{y(prof.cents_ok):.1f}' width='{W - L - 14}' height='{y(-prof.cents_ok) - y(prof.cents_ok):.1f}' fill='var(--good)' opacity='.12'/>")
    for c in (-50, -25, 0, 25, 50):
        if -lim <= c <= lim:
            out.append(f"<line x1='{L}' x2='{W - 14}' y1='{y(c):.1f}' y2='{y(c):.1f}' stroke='var(--grid)'/>"
                       f"<text x='{L - 6}' y='{y(c) + 4:.1f}' text-anchor='end'>{c:+d}</text>")
    for r in pts:
        cat = "sharp" if r.cents > prof.cents_ok else "flat" if r.cents < -prof.cents_ok else "correct"
        color = STATUS_STYLE[cat][0] if cat != "correct" else "var(--ink-2)"
        tip = f"{midi_name(r.expected)} (bar {r.measure + 1}): {r.cents:+.0f} cents"
        out.append(f"<circle cx='{x(r.time):.1f}' cy='{y(r.cents):.1f}' r='10' fill='transparent' data-tip='{_esc(tip)}'/>"
                   f"<circle cx='{x(r.time):.1f}' cy='{y(r.cents):.1f}' r='4.5' fill='{color}' stroke='var(--surface)' stroke-width='2' pointer-events='none'/>")
    out.append("</svg>")
    return (f"<div class='card'>{''.join(out)}<div class='legend'><span>Cents from the written pitch, per note. "
            f"Green band = in tune (±{prof.cents_ok:.0f} c)</span>"
            f"<span><b style='color:var(--sharp)'>↑</b> sharp</span><span><b style='color:var(--flat)'>↓</b> flat</span></div></div>")


def build_report(score: Score, ev: Evaluation, musicxml: str | None = None, buzzes: list | None = None,
                 subtitle: str = "") -> str:
    prof = get_profile(ev.instrument)
    s = ev.scores
    c = s["counts"]
    tiles = [("Overall", f"{s['overall']:.0f}", "out of 100"),
             ("Notes", f"{s['notes']:.0f}", f"{c['wrong']} wrong · {c['missed']} missed · {c['extra']} extra"),
             ("Rhythm", f"{s['rhythm']:.0f}", f"{ev.tempo.get('average_qpm', '—')} BPM average")]
    if s.get("intonation") is not None:
        tiles.append(("Intonation", f"{s['intonation']:.0f}",
                      f"overall {ev.tuning_offset_cents:+.0f} cents" if ev.tuning_offset_cents is not None else ""))
    tiles_html = "".join(f"<div class='tile'><div class='k'>{k}</div><div class='v'>{v}</div><div class='d'>{_esc(d)}</div></div>"
                         for k, v, d in tiles)
    tips = "".join(f"<div class='tip'>{_esc(t)}</div>" for t in ev.tips)
    plan = []
    for p in ev.practice_plan:
        steps = "".join(f"<div class='step'><b>{st['tempo_qpm']} BPM</b><span>{_esc(st['goal'])}</span></div>"
                        for st in p["steps"])
        plan.append(f"<div class='card'><div><b>Loop {_esc(p['loop_label'])}</b> <span class='sub'>· {_esc(p['why'])}</span></div>{steps}</div>")
    buzz_table = ""
    if buzzes:
        rows = "".join(f"<tr><td>{b.time:.2f}s</td><td>{_esc(b.measure_label or '')}</td><td>{_esc(b.type.replace('_', ' '))}</td>"
                       f"<td>{_esc(b.text)}</td></tr>" for b in buzzes)
        buzz_table = (f"<details><summary>What your Watch would have felt ({len(buzzes)} buzzes)</summary>"
                      f"<table><tr><th>Time</th><th>Bar</th><th>Buzz</th><th>Shown</th></tr>{rows}</table></details>")
    sheet_legend = ("<div class='legend'>" + "".join(
        f"<span><b style='color:{STATUS_STYLE[k][0]}'>{STATUS_STYLE[k][1] or '●'}</b> {STATUS_STYLE[k][2]}</span>"
        for k in ("wrong", "missed", "sharp", "flat", "timing")) + "</div>")
    body = f"""
<main>
<h1>{_esc(score.title or 'Practice take')}</h1>
<p class='sub'>{_esc(prof.name)} · {ev.duration_sec:.0f} s take{(' · ' + _esc(subtitle)) if subtitle else ''}</p>
<div class='tiles'>{tiles_html}</div>
<h2>Your score, marked</h2>
<div class='card'>{_coloured_sheet(score, ev, musicxml)}{sheet_legend}</div>
<h2>Bar by bar</h2>
{_heat(score, ev)}
<h2>What you played vs. the score</h2>
{_pianoroll(score, ev, buzzes)}
{buzz_table}
{('<h2>Tempo</h2>' + _tempo_chart(ev)) if _tempo_chart(ev) else ''}
{('<h2>Intonation</h2>' + _intonation_chart(ev, prof)) if prof.intonation and _intonation_chart(ev, prof) else ''}
<h2>Coach's notes</h2>
{tips}
<h2>Practice plan</h2>
<div class='plan'>{''.join(plan)}</div>
<p class='note'>Wrong / missed notes are only marked when the analysis is confident; octave doublings hidden in
another note's overtones are shown as "not judged" instead of counted against you.</p>
</main>"""
    return (f"<!doctype html><html lang='en'><head><meta charset='utf-8'>"
            f"<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>Practice Report</title><style>{CSS}</style></head><body>{body}"
            f"<div id='tt' role='tooltip'></div><script>{JS}</script></body></html>")
