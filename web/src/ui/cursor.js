// The score cursor, MuseScore style: a line that steps from note to note, a soft highlight on the bar,
// the sounding notes lit, and the page following along.
//
// Everything that needs the drawing (where each bar and note head is) is measured once after the score is
// drawn. While playing, each frame only moves two absolutely positioned boxes and changes the class of the
// few notes that start or stop, so long and dense scores stay smooth (the old cursor searched the whole
// drawing for every sounding note 60 times a second, which is what made busy scores stutter).

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

export class ScoreCursor {
  /** box: the element holding Verovio's SVG; layer: an empty element on top of it (same top-left);
   *  perf: performance(score) with {events: [{t, dur, ids, mi, off}], spans: [{mi, t, dur}]} */
  constructor({ box, layer, perf }) {
    this.box = box; this.layer = layer; this.perf = perf;
    const ev = perf.events;
    this.on = Float64Array.from(ev, (e) => e.t.num());
    this.off = Float64Array.from(ev, (e) => e.t.num() + Math.max(e.dur.num(), 1 / 16));
    let maxDur = 0;
    for (let i = 0; i < ev.length; i++) maxDur = Math.max(maxDur, this.off[i] - this.on[i]);
    this.maxDur = maxDur;
    this.spanT = Float64Array.from(perf.spans, (s) => s.t.num());
    this.geo = null; this.active = []; this.ptr = 0; this.lastQ = -1; this.curMi = -1; this.lit = new Set();
    this.line = document.createElement('div'); this.line.className = 'vrv-cursor';
    this.bar = document.createElement('div'); this.bar.className = 'vrv-bar';
    this.line.hidden = true; this.bar.hidden = true;
    layer.replaceChildren(this.bar, this.line);
    this.userScrollAt = 0;
    this.scroller = box.closest('.scroll');
    this.onUserScroll = () => { this.userScrollAt = performance.now(); };
    for (const ev2 of ['wheel', 'touchmove']) this.scroller?.addEventListener(ev2, this.onUserScroll, { passive: true });
    if (globalThis.ResizeObserver) {
      let w = box.clientWidth;
      this.ro = new ResizeObserver(() => { if (box.clientWidth !== w) { w = box.clientWidth; this.geo = null; } });
      this.ro.observe(box);
    }
  }

  destroy() {
    this.unlight();
    this.ro?.disconnect();
    for (const ev2 of ['wheel', 'touchmove']) this.scroller?.removeEventListener(ev2, this.onUserScroll);
    this.line.remove(); this.bar.remove();
  }

  /** Reads where every bar is (one layout read). Note heads are measured bar by bar when first needed, so a
   *  10,000-note score is ready at once. */
  measure() {
    const box = this.box;
    const rb = box.getBoundingClientRect();
    this.origin = { x: rb.left, y: rb.top };
    const byId = new Map();
    for (const g of box.querySelectorAll('g.note')) if (g.id) byId.set(g.id, g);
    const measEls = [...box.querySelectorAll('g.measure')];
    const mEl = new Map();
    const onsetEl = new Map();                      // mi -> Map(off -> note element), the first note at each offset
    for (const e of this.perf.events) {
      for (const id of e.ids) {
        const n = byId.get(id);
        if (!n) continue;
        if (!mEl.has(e.mi)) { const m = n.closest('g.measure'); if (m) mEl.set(e.mi, m); }
        let per = onsetEl.get(e.mi);
        if (!per) onsetEl.set(e.mi, (per = new Map()));
        const k = e.off.num();
        if (!per.has(k)) per.set(k, n);
        break;
      }
    }
    const mBox = new Map();
    let count = measEls.length;
    for (const sp of this.perf.spans) count = Math.max(count, sp.mi + 1);
    for (let mi = 0; mi < count; mi++) {
      const m = mEl.get(mi) || measEls[mi];
      if (!m) continue;
      const r = this.rect(m, rb);
      if (r.w) mBox.set(mi, r);
    }
    this.geo = { byId, mBox, onsetEl, onsets: new Map() };
    this.evEls = new Array(this.perf.events.length);
  }

  rect(el, rb = this.box.getBoundingClientRect()) {
    const r = el.getBoundingClientRect();
    return { x: r.left - rb.left, y: r.top - rb.top, w: r.width, h: r.height };
  }

  /** x of each note start in bar mi: [{off, x}] sorted by offset. */
  onsetsOf(mi) {
    let pts = this.geo.onsets.get(mi);
    if (pts) return pts;
    pts = [];
    const per = this.geo.onsetEl.get(mi);
    if (per) {
      const rb = this.box.getBoundingClientRect();
      for (const [k, n] of per) {
        const hr = this.rect(n.querySelector('.notehead') || n, rb);
        pts.push({ off: k, x: hr.x + hr.w / 2 });
      }
      pts.sort((a, b) => a.off - b.off);
    }
    this.geo.onsets.set(mi, pts);
    return pts;
  }

  elementsFor(ids) {
    if (!this.geo) this.measure();
    return ids.map((id) => this.geo.byId.get(id)).filter(Boolean);
  }

  /** Moves the cursor to performance time q (quarter notes). */
  update(q, { scroll = true, notes = true } = {}) {
    if (!this.geo) this.measure();
    const spans = this.perf.spans;
    if (!spans.length) return null;
    let si = lowerBound(this.spanT, q + 1e-9) - 1;
    if (si < 0) si = 0;
    const span = spans[si];
    const mi = span.mi;
    const mb = this.geo.mBox.get(mi);
    if (notes) this.light(q); else this.unlight();
    if (!mb) { this.line.hidden = true; this.bar.hidden = true; return mi; }
    const offQ = Math.max(0, q - this.spanT[si]);
    // Like MuseScore, the line stands on the note (or chord) being played and steps to the next one when it
    // starts, so the drawing only changes when a note starts (a gliding line repaints every frame).
    const pad = Math.min(14, mb.w * 0.08);
    const pts = this.onsetsOf(mi);
    let x = mb.x + pad;
    for (const p of pts) { if (p.off <= offQ + 1e-9) x = p.x; else break; }
    if (x !== this.lastX || this.line.hidden) {
      this.line.hidden = false;
      this.line.style.transform = `translate3d(${x.toFixed(1)}px, ${mb.y.toFixed(1)}px, 0)`;
      this.lastX = x;
    }
    if (mi !== this.curMi) {
      this.line.style.height = `${mb.h}px`;
      this.line.style.transform = `translate3d(${x.toFixed(1)}px, ${mb.y.toFixed(1)}px, 0)`;
      this.bar.hidden = false;
      this.bar.style.transform = `translate3d(${mb.x}px, ${mb.y}px, 0)`;
      this.bar.style.width = `${mb.w}px`;
      this.bar.style.height = `${mb.h}px`;
      if (scroll) this.follow(mb);
      this.curMi = mi;
    }
    return mi;
  }

  /** Keeps the bar being played in view (unless the player just scrolled by hand). */
  follow(mb) {
    const sc = this.scroller;
    if (!sc || performance.now() - this.userScrollAt < 2500) return;
    const top = this.box.getBoundingClientRect().top + mb.y - sc.getBoundingClientRect().top;
    const view = sc.clientHeight;
    // keep clear of the player controls and tab bar at the bottom of the screen
    if (top < 70 || top + Math.min(mb.h, view * 0.45) > view - 270) sc.scrollBy({ top: top - view * 0.2, behavior: 'smooth' });
  }

  light(q) {
    const n = this.on.length;
    if (q < this.lastQ - 1e-6 || q - this.lastQ > 8 || this.lastQ < 0) {
      this.active = [];
      let i = lowerBound(this.on, q - this.maxDur - 1e-6);
      while (i < n && this.on[i] <= q + 1e-9) { if (this.off[i] > q + 1e-9) this.active.push(i); i++; }
      this.ptr = i;
    } else {
      while (this.ptr < n && this.on[this.ptr] <= q + 1e-9) { if (this.off[this.ptr] > q + 1e-9) this.active.push(this.ptr); this.ptr++; }
      this.active = this.active.filter((i) => this.off[i] > q + 1e-9);
    }
    this.lastQ = q;
    const next = new Set();
    for (const i of this.active) {
      let els = this.evEls[i];
      if (!els) els = this.evEls[i] = this.perf.events[i].ids.map((id) => this.geo.byId.get(id)).filter(Boolean);
      for (const el of els) next.add(el);
    }
    for (const el of this.lit) if (!next.has(el)) el.classList.remove('on');
    for (const el of next) if (!this.lit.has(el)) el.classList.add('on');
    this.lit = next;
  }

  unlight() {
    for (const el of this.lit) el.classList.remove('on');
    this.lit = new Set();
    this.active = []; this.lastQ = -1;
  }

  hide() { this.unlight(); this.line.hidden = true; this.bar.hidden = true; this.curMi = -1; this.lastX = null; }
}
