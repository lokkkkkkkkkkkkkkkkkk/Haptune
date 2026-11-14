"""Band split report: one HTML page with a mixer (play, mute, solo, slow down), the chord chart and
each part's sheet music. Audio comes from the stems/ folder next to the page."""
from __future__ import annotations

import html
import json
import math

from .score import Score

ROLE_COLOR = {"vocals": "--voice", "lead": "--lead", "keys": "--keys", "bass": "--bass", "drums": "--drums"}


def _esc(s) -> str:
    return html.escape(str(s), quote=True)


def _part_svgs(score: Score, part_id: str, max_pages: int = 12) -> list[str]:
    from .export import to_music21
    import verovio
    sub = Score(title=score.title, composer=score.composer, parts=[p for p in score.parts if p.id == part_id],
                notes=[n for n in score.notes if n.part == part_id], measures=score.measures, tempos=score.tempos,
                source=score.source)
    s = to_music21(sub)
    from music21.musicxml.m21ToXml import GeneralObjectExporter
    xml = GeneralObjectExporter(s).parse().decode("utf-8")
    tk = verovio.toolkit()
    tk.setOptions({"pageWidth": 2100, "pageHeight": 2970, "scale": 38, "adjustPageHeight": True, "breaks": "auto",
                   "footer": "none", "header": "none", "svgViewBox": True, "spacingStaff": 10})
    if not tk.loadData(xml):
        return []
    return [tk.renderToSVG(i + 1) for i in range(min(max_pages, tk.getPageCount()))]


def _activity_svg(act: list[float], var: str) -> str:
    n = max(1, len(act))
    bars = []
    for i, a in enumerate(act):
        h = 4 + 20 * a
        op = 0.18 if a < 0.05 else 0.35 + 0.65 * a
        bars.append(f'<rect x="{i}" y="{(24 - h) / 2:.1f}" width="0.8" height="{h:.1f}" rx="0.4" '
                    f'style="fill:var({var})" opacity="{op:.2f}"/>')
    return (f'<svg class="strip" viewBox="0 0 {n} 24" preserveAspectRatio="none" aria-hidden="true">'
            + "".join(bars) + "</svg>")


def _chord_chart(chords: list[dict], beats_per_bar: int, n_bars: int) -> str:
    by_bar: dict[int, list[tuple[float, str]]] = {}
    for c in chords:
        b = int(c["beat"] // beats_per_bar)
        by_bar.setdefault(b, []).append((c["beat"] - b * beats_per_bar, c["label"]))
    cells, current = [], "%"
    for b in range(n_bars):
        items = by_bar.get(b, [])
        if items:
            inner = "".join(f'<span style="left:{100 * pos / beats_per_bar:.0f}%">{_esc(lab)}</span>' for pos, lab in items)
            current = items[-1][1]
        else:
            inner = '<span class="rpt" style="left:0">%</span>' if current != "%" else ""
        cells.append(f'<div class="bar"><i>{b + 1}</i><div class="syms">{inner}</div></div>')
    return "".join(cells)


def build_band_report(result: dict, score: Score, note: str = "") -> str:
    parts = result["parts"]
    beats_per_bar = score.measures[0].time_sig[0] if score.measures else 4
    duration = result["duration"]
    rows = []
    for p in parts:
        var = ROLE_COLOR.get(p["role"], "--other")
        rows.append(f'''
      <div class="row" data-id="{_esc(p["id"])}" style="--c:var({var})">
        <div class="who"><span class="dot"></span><div><b>{_esc(p["name"])}</b><small>{_esc(p.get("instrument_name") or p["instrument"].replace("_", " "))}</small></div></div>
        <div class="lane">{_activity_svg(p["activity"], var)}<div class="head"></div></div>
        <div class="ctl">
          <button class="m" id="m-{_esc(p["id"])}" aria-pressed="false" title="Mute">M</button>
          <button class="s" id="s-{_esc(p["id"])}" aria-pressed="false" title="Solo">S</button>
          <input class="vol" id="v-{_esc(p["id"])}" type="range" min="0" max="1" step="0.01" value="1" aria-label="{_esc(p["name"])} volume">
        </div>
        <audio preload="auto" src="{_esc(p["file"])}"></audio>
      </div>''')
    tabs, panes = [], []
    first = True
    for p in parts:
        if not p.get("score_part"):
            continue
        svgs = _part_svgs(score, p["score_part"])
        if not svgs:
            continue
        pid = _esc(p["id"])
        tabs.append(f'<button role="tab" id="tab-{pid}" aria-selected="{str(first).lower()}" data-pane="pane-{pid}">{_esc(p["name"])}</button>')
        panes.append(f'<div class="pane" id="pane-{pid}" role="tabpanel"{"" if first else " hidden"}>'
                     + "".join(f'<div class="page">{svg}</div>' for svg in svgs) + "</div>")
        first = False
    n_bars = len(score.measures)
    chart = _chord_chart(result.get("chords") or [], beats_per_bar, n_bars) if result.get("chords") else ""
    mins = f"{int(duration // 60)}:{int(duration % 60):02d}"
    data = json.dumps({"duration": duration, "bpm": result.get("bpm"), "offset": result.get("offset", 0),
                       "beatsPerBar": beats_per_bar})
    return f'''<title>{_esc(result.get("page_title") or "Band Split")}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&display=swap">
<style>
/* Layout: one column like a rehearsal binder - sticky transport, the mixer, then chords and parts on paper */
:root {{
  --bg: #f1f0f5; --card: #ffffff; --ink: #19181d; --muted: #6c6a76; --line: #e2e0e9; --accent: #5a49d6;
  --paper: #fffdf8; --paper-ink: #1b1a1f;
  --voice: #d93d76; --lead: #e07a2e; --keys: #2c74de; --bass: #2a9a62; --drums: #85828f; --other: #179c9c;
  --font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif;
  --font-chord: "Barlow Condensed", "Arial Narrow", "Helvetica Neue", sans-serif;
  --font-num: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
  --bg: #0d0c11; --card: #1a1920; --ink: #f0eff5; --muted: #a3a0ad; --line: #2c2a33; --accent: #9184ff;
  --paper: #f3f0e6; --paper-ink: #1b1a1f;
  --voice: #ff5c94; --lead: #ff9a4d; --keys: #4f95ff; --bass: #3fc283; --drums: #a19eab; --other: #33c2c2; color-scheme: dark }} }}
:root[data-theme="dark"] {{
  --bg: #0d0c11; --card: #1a1920; --ink: #f0eff5; --muted: #a3a0ad; --line: #2c2a33; --accent: #9184ff;
  --paper: #f3f0e6; --paper-ink: #1b1a1f;
  --voice: #ff5c94; --lead: #ff9a4d; --keys: #4f95ff; --bass: #3fc283; --drums: #a19eab; --other: #33c2c2; color-scheme: dark }}
* {{ box-sizing: border-box }}
body {{ background: var(--bg); color: var(--ink); font: 15px/1.45 var(--font-ui);
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 0 48px }}
body::before {{ content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--bg) }}
main {{ max-width: 920px; margin: 0 auto; display: grid; gap: 22px }}
header.top {{ padding-top: 22px; display: grid; gap: 6px }}
.eyebrow {{ font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); font-weight: 650 }}
h1 {{ font-size: clamp(26px, 5vw, 34px); line-height: 1.1; margin: 0; text-wrap: balance; letter-spacing: -.01em }}
.facts {{ display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px }}
.fact {{ background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; font-size: 13px; color: var(--muted) }}
.fact b {{ color: var(--ink); font-variant-numeric: tabular-nums }}
.transport {{ position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; background: var(--bg); padding-block: 10px;
  display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; border-bottom: 1px solid var(--line) }}
.play {{ width: 52px; height: 52px; border-radius: 50%; border: 0; background: var(--accent); color: #fff; font-size: 20px; cursor: pointer }}
.play:focus-visible, button:focus-visible, input:focus-visible {{ outline: 3px solid var(--accent); outline-offset: 2px }}
.scrub {{ display: grid; gap: 4px; min-width: 0 }}
.scrub input {{ width: 100%; accent-color: var(--accent) }}
.time {{ font: 13px var(--font-num); color: var(--muted); display: flex; justify-content: space-between }}
.speed {{ display: grid; gap: 2px; justify-items: end; font-size: 12px; color: var(--muted) }}
.speed select {{ font: inherit; color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 4px 6px }}
section h2 {{ font-size: 20px; margin: 0 0 10px; text-wrap: balance }}
.mixer {{ background: var(--card); border: 1px solid var(--line); border-radius: 16px; overflow: hidden }}
.row {{ display: grid; grid-template-columns: minmax(120px, 170px) 1fr auto; gap: 12px; align-items: center; padding: 12px 14px; border-top: 1px solid var(--line) }}
.row:first-child {{ border-top: 0 }}
.who {{ display: flex; gap: 10px; align-items: center; min-width: 0 }}
.who b {{ display: block }} .who small {{ color: var(--muted) }}
.dot {{ width: 12px; height: 12px; border-radius: 4px; background: var(--c); flex: none }}
.lane {{ position: relative; height: 28px; min-width: 0 }}
.strip {{ width: 100%; height: 100%; display: block }}
.head {{ position: absolute; top: -2px; bottom: -2px; width: 2px; left: 0; background: var(--ink); border-radius: 1px }}
.ctl {{ display: flex; gap: 6px; align-items: center }}
.ctl button {{ width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); font-weight: 700; cursor: pointer }}
.ctl button.m[aria-pressed="true"] {{ background: var(--muted); color: var(--card) }}
.ctl button.s[aria-pressed="true"] {{ background: var(--c); color: #fff; border-color: transparent }}
.vol {{ width: 84px; accent-color: var(--c) }}
.row.off .who, .row.off .lane {{ opacity: .35 }}
.chart {{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); background: var(--card); border: 1px solid var(--line); border-radius: 16px; overflow: hidden }}
.bar {{ position: relative; min-height: 64px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 6px 8px }}
.bar:nth-child(4n) {{ border-right: 0 }}
.bar i {{ font: 11px var(--font-num); color: var(--muted); font-style: normal }}
.syms {{ position: relative; height: 34px }}
.syms span {{ position: absolute; top: 2px; font: 700 24px/1 var(--font-chord); letter-spacing: .01em; white-space: nowrap }}
.syms span.rpt {{ color: var(--muted); font-weight: 600 }}
.tabs {{ display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px }}
.tabs button {{ border: 1px solid var(--line); background: var(--card); color: var(--ink); padding: 7px 14px; border-radius: 999px; font: 600 14px var(--font-ui); cursor: pointer }}
.tabs button[aria-selected="true"] {{ background: var(--ink); color: var(--bg); border-color: var(--ink) }}
.page {{ background: var(--paper); color: var(--paper-ink); border-radius: 6px; padding: 10px; margin-bottom: 12px; box-shadow: 0 1px 0 var(--line) }}
.page svg {{ width: 100%; height: auto; display: block; color: var(--paper-ink) }}
.note {{ color: var(--muted); font-size: 14px; max-width: 65ch }}
@media (max-width: 620px) {{
  .row {{ grid-template-columns: 1fr auto; }}
  .lane {{ grid-column: 1 / -1; order: 3 }}
  .vol {{ width: 64px }}
  .chart {{ grid-template-columns: repeat(2, minmax(0, 1fr)) }}
  .bar:nth-child(4n) {{ border-right: 1px solid var(--line) }} .bar:nth-child(2n) {{ border-right: 0 }}
}}
@media (prefers-reduced-motion: reduce) {{ * {{ transition: none !important }} }}
</style>
<main>
  <header class="top">
    <span class="eyebrow">Melovyn · Band Split</span>
    <h1>{_esc(result["title"])}</h1>
    <div class="facts">
      <span class="fact">Parts <b>{len(parts)}</b></span>
      <span class="fact">Key <b>{_esc(result.get("key") or "–")}</b></span>
      <span class="fact">Tempo <b>{round(result.get("bpm") or 0)} BPM</b></span>
      <span class="fact">Length <b>{mins}</b></span>
      <span class="fact">Bars <b>{n_bars}</b></span>
    </div>
  </header>
  <div class="transport">
    <button class="play" id="play" aria-label="Play">▶</button>
    <div class="scrub">
      <input id="pos" type="range" min="0" max="{duration:.2f}" step="0.05" value="0" aria-label="Position">
      <div class="time"><span id="now">0:00</span><span id="bar">Bar 1</span><span>{mins}</span></div>
    </div>
    <label class="speed" for="rate">Speed
      <select id="rate"><option value="1">100%</option><option value="0.9">90%</option><option value="0.8">80%</option>
      <option value="0.7">70%</option><option value="0.6">60%</option><option value="0.5">50%</option></select>
    </label>
  </div>
  <section>
    <h2>Parts</h2>
    <div class="mixer">{"".join(rows)}</div>
    <p class="note">Solo a part to hear it alone, or mute yours and play along with the rest. Slowing down keeps the pitch.</p>
  </section>
  {f'<section><h2>Chords</h2><div class="chart">{chart}</div></section>' if chart else ""}
  {f'<section><h2>Sheet music</h2><div class="tabs" role="tablist">{"".join(tabs)}</div>{"".join(panes)}</section>' if tabs else ""}
  <section><p class="note">{_esc(note)}</p></section>
</main>
<script>
const INFO = {data};
const rows = [...document.querySelectorAll('.row')].map(r => ({{ el: r, id: r.dataset.id, a: r.querySelector('audio'),
  m: r.querySelector('.m'), s: r.querySelector('.s'), v: r.querySelector('.vol'), head: r.querySelector('.head') }}));
const play = document.getElementById('play'), pos = document.getElementById('pos'), now = document.getElementById('now'),
  barEl = document.getElementById('bar'), rate = document.getElementById('rate');
let playing = false, solo = null;
const fmt = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
function gains() {{
  for (const r of rows) {{
    const on = solo ? solo === r.id : r.m.getAttribute('aria-pressed') !== 'true';
    r.a.volume = on ? Number(r.v.value) : 0;
    r.el.classList.toggle('off', !on);
  }}
}}
function master() {{ return rows[0] ? rows[0].a : null }}
function seek(t) {{ for (const r of rows) {{ try {{ r.a.currentTime = t }} catch (e) {{}} }} draw(t) }}
function draw(t) {{
  pos.value = t; now.textContent = fmt(t);
  const beat = (t - INFO.offset) * (INFO.bpm || 120) / 60;
  barEl.textContent = 'Bar ' + Math.max(1, Math.floor(beat / INFO.beatsPerBar) + 1);
  for (const r of rows) r.head.style.left = (100 * t / INFO.duration) + '%';
}}
async function toggle() {{
  if (playing) {{ rows.forEach(r => r.a.pause()); playing = false; play.textContent = '▶'; play.setAttribute('aria-label', 'Play'); return }}
  const t = master() ? master().currentTime : 0;
  for (const r of rows) {{ r.a.playbackRate = Number(rate.value); r.a.preservesPitch = true; r.a.currentTime = t }}
  try {{ await Promise.all(rows.map(r => r.a.play())) }} catch (e) {{}}
  playing = true; play.textContent = '❚❚'; play.setAttribute('aria-label', 'Pause');
}}
play.addEventListener('click', toggle);
pos.addEventListener('input', () => seek(Number(pos.value)));
rate.addEventListener('change', () => rows.forEach(r => r.a.playbackRate = Number(rate.value)));
for (const r of rows) {{
  r.m.addEventListener('click', () => {{ r.m.setAttribute('aria-pressed', r.m.getAttribute('aria-pressed') !== 'true'); gains() }});
  r.s.addEventListener('click', () => {{
    solo = solo === r.id ? null : r.id;
    rows.forEach(x => x.s.setAttribute('aria-pressed', String(solo === x.id))); gains();
  }});
  r.v.addEventListener('input', gains);
  r.el.querySelector('.lane').addEventListener('click', ev => {{
    const b = ev.currentTarget.getBoundingClientRect(); seek(INFO.duration * (ev.clientX - b.left) / b.width);
  }});
}}
// keep the parts in step: the first part is the clock
setInterval(() => {{
  const m = master(); if (!m) return;
  const t = m.currentTime; if (!playing) return; draw(t);
  for (const r of rows.slice(1)) if (Math.abs(r.a.currentTime - t) > 0.08) r.a.currentTime = t;
  if (m.ended) {{ playing = false; play.textContent = '▶' }}
}}, 120);
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {{
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('.pane').forEach(p => p.hidden = p.id !== b.dataset.pane);
}}));
gains(); draw(0);
</script>
'''
