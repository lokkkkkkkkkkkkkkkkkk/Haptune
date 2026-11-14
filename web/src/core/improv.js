// On-device improviser. Given a chord progression, a style and a level it writes a solo that follows
// the harmony: chord tones on strong beats, scale and passing tones between, a motif that is repeated
// and answered in 4-bar phrases, phrase endings on stable notes, and a range that suits the instrument.
// It also writes the backing band (comping, bass, drums) for playback.
import { q, ZERO } from './q.js';
import { iv, mod, pc, transposeName, tonicOf, transposeInterval, transposeKey, spellMidi, keyName } from './pitch.js';
import { parseChord, formatChord, chordPcs, rootPc, chordToneLabel, transposeChord, QUALITIES, isDiatonic } from './chords.js';
import { notesFromSpans, recomputeStarts, measureLength, makeNote, beatLength, isCompound } from './score.js';

// ---------- random ----------
export function rng(seed) {
  let a = seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.weighted = (items, weights) => {
    const total = weights.reduce((s, w) => s + w, 0);
    let r = next() * total;
    for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
    return items[items.length - 1];
  };
  return next;
}

// ---------- styles ----------
export const STYLES = {
  pop: { tempo: 96, swing: 0, scale: 'chord', comp: 'pop', bass: 'pop', drums: 'pop', busy: 1 },
  ballad: { tempo: 72, swing: 0, scale: 'chord', comp: 'arpeggio', bass: 'long', drums: 'soft', busy: 0.6 },
  blues: { tempo: 96, swing: 0.67, scale: 'blues', comp: 'shuffle', bass: 'walk', drums: 'shuffle', busy: 1.1 },
  jazz: { tempo: 132, swing: 0.67, scale: 'bebop', comp: 'charleston', bass: 'walk', drums: 'swing', busy: 1.2 },
  bossa: { tempo: 128, swing: 0, scale: 'chord', comp: 'bossa', bass: 'bossa', drums: 'bossa', busy: 1 },
  baroque: { tempo: 92, swing: 0, scale: 'chord', comp: 'alberti', bass: 'continuo', drums: null, busy: 1.4 },
  pentatonic: { tempo: 80, swing: 0, scale: 'pentatonic', comp: 'arpeggio', bass: 'long', drums: null, busy: 0.8 },
  rock: { tempo: 116, swing: 0, scale: 'minorpent', comp: 'power', bass: 'eighths', drums: 'rock', busy: 1.1 },
};

// Progressions in Roman-numeral form, written as chords in C major / A minor and moved to the chosen key.
export const PROGRESSIONS = {
  axis: { name: 'I–V–vi–IV (pop)', chords: ['C', 'G', 'Am', 'F'], mode: 'major' },
  fifties: { name: 'I–vi–IV–V (50s)', chords: ['C', 'Am', 'F', 'G'], mode: 'major' },
  canon: { name: 'Canon', chords: ['C', 'G', 'Am', 'Em', 'F', 'C', 'F', 'G'], mode: 'major' },
  royal: { name: 'IV–V–iii–vi (C-pop)', chords: ['F', 'G', 'Em', 'Am'], mode: 'major' },
  twoFiveOne: { name: 'ii–V–I (jazz)', chords: ['Dm7', 'G7', 'Cmaj7', 'Cmaj7'], mode: 'major' },
  blues: { name: '12-bar blues', chords: ['C7', 'C7', 'C7', 'C7', 'F7', 'F7', 'C7', 'C7', 'G7', 'F7', 'C7', 'G7'], mode: 'major' },
  minorPop: { name: 'i–VI–III–VII', chords: ['Am', 'F', 'C', 'G'], mode: 'minor' },
  andalusian: { name: 'Andalusian', chords: ['Am', 'G', 'F', 'E'], mode: 'minor' },
  bossaTurn: { name: 'Bossa turnaround', chords: ['Cmaj7', 'A7', 'Dm7', 'G7'], mode: 'major' },
};

// Rhythm patterns per bar: x = note starts, . = holds, - = rest. Slots are eighths (or sixteenths when 16 long).
const BAR_PATTERNS = {
  '4/4': {
    1: ['x.x.x.x.', 'x...x...', 'x.x.x...', 'x...x.x.', 'x.x.x.--', 'x.....--', 'x.x.x.x.', '--x.x.x.'],
    2: ['x.xxx.x.', 'xxx.x.x.', 'x..xx...', 'x.xx.x.-', 'x.x..x..', '-xx.x.x.', 'x.x.xxx.', 'xx.xx.x.', 'x..x..x.'],
    3: ['x.xxxxx.', 'xxxxx.x.', 'x.xx.xxx', '-xxx.xx.', 'xxx.xxx.', 'x.xxxx..', 'x.x.x.xxxxxx....'.slice(0, 8), 'xxxxxxxx'],
    cadence: ['x.x.x...', 'x.......', 'x...x...', 'x.x.....', 'xxx.x...'],
  },
  '3/4': {
    1: ['x.x.x.', 'x...x.', 'x.....', 'x.x...', 'x...--'],
    2: ['x.xxx.', 'xxx.x.', 'x..xx.', 'x.x.xx', 'x.xx.-'],
    3: ['xxxxx.', 'x.xxxx', 'xxx.xx', 'x.xxx.', 'xxxxxx'],
    cadence: ['x.....', 'x...x.', 'x.x...'],
  },
  '6/8': {
    1: ['x..x..', 'x.....', 'x.xx..', 'x..x.x'],
    2: ['x.xx.x', 'xxxx..', 'x..xxx', 'xxxx.x'],
    3: ['xxxxxx', 'x.xxxx', 'xxx.xx', 'xx.xxx'],
    cadence: ['x.....', 'x..x..', 'x.x...'],
  },
  '2/4': {
    1: ['x.x.', 'x...', 'xxx.'],
    2: ['x.xx', 'xxx.', 'xx.x'],
    3: ['xxxx', 'x.xx', 'xxxx'],
    cadence: ['x...', 'x.x.'],
  },
};

function meterKey(time) {
  const k = `${time.beats}/${time.beatType}`;
  return BAR_PATTERNS[k] ? k : time.beatType === 8 ? '6/8' : '4/4';
}

/** Expands a progression (chord names or chords) into bar-by-bar spans: [{bar, off: Q, dur: Q, chord}] */
export function layoutProgression(progression, bars, time) {
  const barLen = measureLength(time);
  const list = progression.map((p) => {
    if (typeof p === 'string') return { chord: parseChord(p), dur: barLen };
    if (p.root) return { chord: p, dur: barLen };
    return { chord: p.chord || parseChord(p.name), dur: p.dur || barLen };
  }).filter((x) => x.chord);
  const spans = [];
  let t = ZERO, i = 0;
  const total = barLen.mul(bars);
  while (t.lt(total) && list.length) {
    const it = list[i % list.length];
    let d = it.dur;
    if (t.add(d).gt(total)) d = total.sub(t);
    spans.push({ t, dur: d, chord: it.chord });
    t = t.add(d);
    i++;
  }
  return spans;
}

function chordAt(spans, t) {
  for (const s of spans) if (s.t.le(t) && s.t.add(s.dur).gt(t)) return s.chord;
  return spans[spans.length - 1]?.chord;
}

/** Pitch classes allowed over a chord in a style. */
export function scaleFor(chord, key, style) {
  const tonic = tonicOf(key);
  const t = pc(tonic.step, tonic.alter);
  const minorKey = key.mode === 'minor';
  const keyScale = (minorKey ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map((s) => mod(t + s, 12));
  const r = rootPc(chord);
  const tones = chordPcs(chord);
  if (style === 'pentatonic') {
    const pent = (minorKey ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9]).map((s) => mod(t + s, 12));
    return new Set([...pent]);
  }
  if (style === 'minorpent') return new Set([0, 3, 5, 7, 10].map((s) => mod((minorKey ? t : mod(t + 9, 12)) + s, 12)));
  if (style === 'blues') {
    // the blues scale of the key, plus the chord's own third so major chords still sound right
    const base = minorKey ? t : t;
    const blues = [0, 3, 5, 6, 7, 10].map((s) => mod(base + s, 12));
    if (!minorKey) blues.push(mod(base + 4, 12), mod(base + 9, 12));
    return new Set([...blues, ...tones.slice(0, 2)]);
  }
  // chord-scale: diatonic notes, with the chord's tones replacing clashing ones
  const set = new Set(keyScale);
  if (!isDiatonic(chord, key)) {
    for (const p of tones) set.add(p);
    // remove scale notes a semitone away from chord tones that would clash
    for (const p of [...set]) if (!tones.includes(p) && tones.some((c) => mod(p - c, 12) === 1 || mod(c - p, 12) === 1) && !keyScale.includes(p)) set.delete(p);
    for (const p of keyScale) if (tones.some((c) => mod(p - c, 12) === 1 || mod(c - p, 12) === 1) && !tones.includes(p)) set.delete(p);
    for (const p of tones) set.add(p);
  }
  if (style === 'bebop') {
    // bebop passing tones: major 7th on dominant chords, sharp 5th on major chords (weak beats only)
    const q2 = chord.quality;
    if (['7', '9', '13', '7b9', '7#9', '7sus4'].includes(q2)) set.add(mod(r + 11, 12));
    else if (['maj', 'maj7', '6', 'maj9', '69'].includes(q2)) set.add(mod(r + 8, 12));
  }
  return set;
}

export const RANGES = {
  violin: [55, 88], viola: [48, 79], cello: [36, 69], flute: [60, 93], recorder: [60, 86], clarinet: [52, 84], sax: [49, 80], trumpet: [52, 82],
  voice: [55, 74], soprano: [60, 79], alto: [53, 72], tenor: [48, 67], bass: [40, 60], piano: [55, 84], guitar: [52, 81], erhu: [62, 86], dizi: [67, 91], ukulele: [60, 81], keyboard: [55, 84],
};

/**
 * Writes an improvisation.
 * opts: {key, time, progression (names or {chord,dur}), bars, style, level 1..3, instrument, seed, tempo}
 * Returns {score, labels: Map(noteId -> 'R'|'3'|'5'|'7'|'9'|'p' passing|'a' approach), spans, style}
 */
export function improvise(opts) {
  const style = STYLES[opts.style] || STYLES.pop;
  const level = Math.max(1, Math.min(3, opts.level || 2));
  const time = opts.time || { beats: 4, beatType: 4 };
  const bars = opts.bars || 8;
  const key = opts.key || { fifths: 0, mode: 'major' };
  const spans = layoutProgression(opts.progression, bars, time);
  const rand = rng(opts.seed || 1);
  const [lo, hi] = RANGES[opts.instrument] || RANGES.violin;
  // centre the line in the comfortable middle of the range
  const centre = Math.round(lo + (hi - lo) * 0.45);
  const span = Math.min(hi - lo, level === 1 ? 12 : level === 2 ? 17 : 22);
  const low = Math.max(lo, centre - Math.floor(span / 2)), high = Math.min(hi, low + span);
  const mk = meterKey(time);
  const pats = BAR_PATTERNS[mk];
  const barLen = measureLength(time);
  const slots = pats[1][0].length;
  const slotLen = barLen.div(slots);
  const strongSlots = mk === '4/4' ? [0, slots / 2] : mk === '6/8' ? [0, 3] : [0];
  const choosePattern = (lv) => {
    const pool = [...pats[1]];
    if (lv >= 2) pool.push(...pats[2], ...pats[2]);
    if (lv >= 3) pool.push(...pats[3], ...pats[3]);
    if (style.busy < 0.8) return rand.pick(pats[1]);
    return rand.pick(pool);
  };
  // phrase plan: rhythm per bar
  const rhythms = [];
  let motif = null;
  for (let b = 0; b < bars; b++) {
    const inPhrase = b % 4;
    const lastBar = b === bars - 1;
    let pat;
    if (inPhrase === 3 || lastBar) pat = rand.pick(pats.cadence);
    else if (inPhrase === 0) {
      if (b >= 4 && rand() < 0.65 && rhythms[b - 4]) pat = rhythms[b - 4]; // answer the first phrase with the same rhythm
      else pat = choosePattern(level);
      motif = pat;
    } else if (inPhrase === 1) pat = rand() < 0.55 ? motif : choosePattern(level);
    else pat = choosePattern(Math.min(3, level + (rand() < 0.4 ? 1 : 0)));
    rhythms.push(pat);
  }
  // notes with onsets and durations
  const events = [];
  rhythms.forEach((pat, b) => {
    const barStart = barLen.mul(b);
    for (let s = 0; s < pat.length; s++) {
      if (pat[s] !== 'x') continue;
      let e = s + 1;
      while (e < pat.length && pat[e] === '.') e++;
      events.push({ t: barStart.add(slotLen.mul(s)), dur: slotLen.mul(e - s), bar: b, slot: s, strong: strongSlots.includes(s) || s === 0 });
    }
  });
  // pitches
  const labels = new Map();
  let prev = null, prevDir = 0, repeats = 0;
  const motifIntervals = [];
  const tonic = tonicOf(key);
  const tonicPc = pc(tonic.step, tonic.alter);
  events.forEach((ev, i) => {
    const chord = chordAt(spans, ev.t);
    const tones = chordPcs(chord);
    const scale = scaleFor(chord, key, style.scale);
    const phrasePos = (ev.bar % 4) + ev.slot / slots;
    const isPhraseEnd = (ev.bar % 4 === 3 || ev.bar === bars - 1) && (i === events.length - 1 || events[i + 1].bar !== ev.bar);
    const isLast = i === events.length - 1;
    const wantDir = phrasePos < 2 ? 1 : -1;
    const cands = [], weights = [];
    for (let m = low; m <= high; m++) {
      const p = mod(m, 12);
      const isChord = tones.includes(p);
      if (!scale.has(p) && !isChord) continue;
      let w = 1;
      if (ev.strong || ev.dur.ge(1)) {
        w *= isChord ? (p === rootPc(chord) || p === tones[1] ? 5 : 3.5) : level >= 2 && chordToneLabel(chord, p) === '9' ? 1.2 : 0.2;
      } else w *= isChord ? 1.25 : 1.1;
      if (prev !== null) {
        const d = Math.abs(m - prev);
        w *= d === 0 ? (repeats >= 1 ? 0.12 : 0.5) : d <= 2 ? 5.5 : d <= 4 ? 2 : d <= 7 ? 0.6 : d <= 12 ? 0.15 : 0.03;
        const dir = Math.sign(m - prev);
        if (dir === wantDir) w *= 1.35;
        if (Math.abs(prevDir) > 4 && dir === Math.sign(prevDir)) w *= 0.3; // after a leap, step back
      } else {
        // start near the middle, on a chord tone
        w *= Math.exp(-Math.abs(m - centre) / 4);
      }
      // stay near the middle of the range
      w *= Math.exp(-Math.max(0, Math.abs(m - centre) - span / 3) / 3);
      // motif sequence: in the second bar of a phrase, follow the first bar's intervals
      if (ev.bar % 4 === 1 && motifIntervals.length && prev !== null) {
        const k = events.filter((x) => x.bar === ev.bar && x.t.lt(ev.t)).length;
        if (k >= 1 && motifIntervals[k - 1] !== undefined && Math.abs(m - (prev + motifIntervals[k - 1])) <= 1) w *= 4;
      }
      if (isPhraseEnd) {
        const stable = isLast ? [tonicPc] : [rootPc(chord), tones[1], tones[2]];
        w *= stable.includes(p) ? (isLast && p === tonicPc ? 12 : 4) : 0.05;
      }
      cands.push(m); weights.push(w);
    }
    let m = cands.length ? rand.weighted(cands, weights) : (prev ?? centre);
    if (ev.bar % 4 === 0) {
      if (prev !== null && events[i - 1]?.bar === ev.bar) motifIntervals.push(m - prev);
      else if (ev.slot === pat0(events, ev)) motifIntervals.length = 0;
    }
    repeats = prev === m ? repeats + 1 : 0;
    prevDir = prev === null ? 0 : m - prev;
    prev = m;
    ev.midi = m;
    ev.chord = chord;
  });
  // level 3 jazz/blues: chromatic approach notes into strong-beat chord tones
  if (level >= 3 && ['bebop', 'blues'].includes(style.scale)) {
    for (let i = 0; i + 1 < events.length; i++) {
      const a = events[i], b = events[i + 1];
      if (!a.strong && b.strong && a.dur.le(q(1, 2)) && rand() < 0.35) a.midi = b.midi - 1;
    }
  }
  // labels and spelling
  const out = [];
  events.forEach((ev) => {
    const p = mod(ev.midi, 12);
    let lab = chordToneLabel(ev.chord, p);
    if (!lab) lab = scaleFor(ev.chord, key, style.scale).has(p) ? 'p' : 'a';
    out.push({ ...ev, label: lab });
  });
  const score = buildScore(out, { key, time, bars, spans, tempo: opts.tempo || style.tempo, instrument: opts.instrument || 'violin', title: opts.title, styleName: opts.style });
  for (const part of score.parts) for (const pm of part.measures) for (const n of pm.notes) if (n.label) labels.set(n.id, n.label);
  return { score, labels, spans, style: opts.style, swing: style.swing, events: out };
}

function pat0(events, ev) { return events.find((x) => x.bar === ev.bar)?.slot; }

function buildScore(events, { key, time, bars, spans, tempo, instrument, title, styleName }) {
  const barLen = measureLength(time);
  const score = { title: title || 'Improvisation', composer: 'Melovyn AI', lyricist: '', measures: [], parts: [], meta: { source: 'improv', style: styleName } };
  const part = { id: 'P1', name: instrumentLabel(instrument), abbr: '', instrument, program: null, transpose: null, staves: 1, measures: [] };
  const clef = (RANGES[instrument] || [55])[0] < 50 ? { staff: 1, sign: 'F', line: 4, oct: 0, off: ZERO } : { staff: 1, sign: 'G', line: 2, oct: 0, off: ZERO };
  for (let b = 0; b < bars; b++) {
    const start = barLen.mul(b);
    const m = { number: String(b + 1), implicit: false, start, dur: barLen, left: {}, right: {}, jumps: {} };
    if (b === 0) { m.time = { ...time }; m.tempo = tempo; }
    if (b === bars - 1) m.right = { style: 'light-heavy' };
    score.measures.push(m);
    const items = events.filter((e) => e.bar === b).map((e) => {
      const n = spellMidi(e.midi, key.fifths);
      return { off: e.t.sub(start), dur: e.dur, pitch: n, label: e.label };
    });
    const notes = notesFromSpans(items, time);
    // copy labels to the first note of each item
    const harmonies = spans.filter((s) => s.t.ge(start) && s.t.lt(start.add(barLen))).map((s) => ({ off: s.t.sub(start), chord: s.chord, text: formatChord(s.chord) }));
    part.measures.push({ key: b === 0 ? key : null, clefs: b === 0 ? [clef] : [], harmonies, notes, directions: [], extraAttrs: [] });
  }
  score.parts.push(part);
  recomputeStarts(score);
  return score;
}

export function instrumentLabel(k) {
  return { violin: 'Violin', viola: 'Viola', cello: 'Cello', flute: 'Flute', recorder: 'Recorder', clarinet: 'Clarinet', sax: 'Saxophone', trumpet: 'Trumpet', voice: 'Voice', piano: 'Piano', guitar: 'Guitar', erhu: 'Erhu', dizi: 'Dizi', ukulele: 'Ukulele', keyboard: 'Keyboard' }[k] || 'Melody';
}

/** A copy of the score with each note's role written under it (R 3 5 7 9, p = passing, a = approach). */
export function withLabels(score, labels) {
  return {
    ...score,
    parts: score.parts.map((p) => ({
      ...p,
      measures: p.measures.map((pm) => ({
        ...pm,
        notes: pm.notes.map((n) => (labels.has(n.id) && !n.tie.stop ? { ...n, lyrics: [{ n: '1', syl: 'single', text: labels.get(n.id) === 'p' ? '·' : labels.get(n.id) === 'a' ? '→' : labels.get(n.id) }] } : n)),
      })),
    })),
  };
}

/** Progression of a library piece: [{chord, dur}] from its chord symbols (bars without a change keep the chord). */
export function progressionFromScore(score, maxBars = 16) {
  const out = [];
  const track = [];
  score.parts.forEach((part) => {
    if (track.length) return;
    part.measures.forEach((pm, mi) => pm.harmonies.forEach((h) => { if (h.chord && !h.chord.nc) track.push({ t: score.measures[mi].start.add(h.off), chord: h.chord }); }));
  });
  if (!track.length) return null;
  track.sort((a, b) => a.t.cmp(b.t));
  const first = track[0].t;
  const endLimit = score.measures.reduce((s, m) => s.add(m.dur), ZERO);
  for (let i = 0; i < track.length; i++) {
    const end = i + 1 < track.length ? track[i + 1].t : endLimit;
    if (end.gt(track[i].t)) out.push({ chord: track[i].chord, dur: end.sub(track[i].t) });
  }
  // keep whole bars up to maxBars
  const bar = measureLength(score.measures[0]?.time || { beats: 4, beatType: 4 });
  let total = ZERO;
  const kept = [];
  for (const x of out) {
    if (total.add(x.dur).gt(bar.mul(maxBars))) break;
    kept.push(x); total = total.add(x.dur);
  }
  void first;
  return kept.length ? kept : out.slice(0, 4);
}

export function progressionInKey(id, key) {
  const p = PROGRESSIONS[id] || PROGRESSIONS.axis;
  const from = { fifths: 0, mode: p.mode };
  const target = { fifths: key.fifths, mode: p.mode === 'minor' ? 'minor' : 'major' };
  const t = tonicOf(target), f = tonicOf(from);
  const semis = mod(pc(t.step, t.alter) - pc(f.step, f.alter), 12);
  const interval = transposeInterval(from, semis > 6 ? semis - 12 : semis);
  const chords = p.chords.map((c) => transposeChord(parseChord(c), interval));
  // respell into the target key signature direction
  return chords;
}

// ---------- backing band ----------

/**
 * Backing events for playback: [{t, dur (Q), midi, vel, inst: 'keys'|'bass'|'drums', drum?}]
 */
export function backing(spans, { style = 'pop', time = { beats: 4, beatType: 4 }, bars = 8, seed = 3 } = {}) {
  const st = STYLES[style] || STYLES.pop;
  const rand = rng(seed);
  const out = [];
  const barLen = measureLength(time);
  const beat = beatLength(time);
  const compound = isCompound(time);
  const beats = Math.round(barLen.div(beat).num());
  const voicing = (chord, low = 53) => {
    const tones = QUALITIES[chord.quality].iv.slice(0, 4).map(([, s]) => rootPc(chord) + s);
    // close voicing above `low`
    return tones.map((pcv) => { let m = low + mod(pcv - low, 12); return m; }).sort((a, b) => a - b);
  };
  const bassNote = (chord, which = 0) => {
    const r = chord.bass ? pc(chord.bass.step, chord.bass.alter) : rootPc(chord);
    const tones = [r, mod(rootPc(chord) + (QUALITIES[chord.quality].iv[2]?.[1] ?? 7), 12), mod(rootPc(chord) + (QUALITIES[chord.quality].iv[1]?.[1] ?? 4), 12)];
    let m = 36 + mod(tones[which % tones.length] - 36, 12);
    if (m > 47) m -= 12;
    return m;
  };
  const push = (t, dur, midi, vel, inst, drum) => out.push({ t, dur, midi, vel, inst, drum });
  for (const sp of spans) {
    const ch = sp.chord;
    if (!ch || ch.nc) continue;
    const v = voicing(ch);
    const nBeats = Math.max(1, Math.round(sp.dur.div(beat).num()));
    const isBarStart = sp.t.div(barLen).d === 1;
    for (let b = 0; b < nBeats; b++) {
      const t = sp.t.add(beat.mul(b));
      const half = beat.div(2);
      // ---- keys ----
      switch (st.comp) {
        case 'pop':
          if (b === 0 || b === 2) v.forEach((m) => push(t, beat.mul(b === 0 ? 1 : 1), m, 62, 'keys'));
          if (b === 1 || b === 3) v.forEach((m) => push(t.add(half), half, m, 56, 'keys'));
          break;
        case 'arpeggio': {
          const arp = [v[0] - 12, v[2] - 12 + 12 * 0, v[0], v[1], v[2], v[1]];
          const steps = compound ? 3 : 2;
          for (let k = 0; k < steps; k++) push(t.add(beat.div(steps).mul(k)), beat.div(steps).mul(2), arp[(b * steps + k) % arp.length], 52, 'keys');
          break;
        }
        case 'shuffle':
          if (b % 2 === 1) v.forEach((m) => push(t, half, m, 58, 'keys'));
          break;
        case 'charleston':
          if (b === 0) v.forEach((m) => push(t, beat.mul(q(3, 2)), m, 58, 'keys'));
          if (b === 1) v.forEach((m) => push(t.add(half), half, m, 54, 'keys'));
          break;
        case 'bossa':
          if (b === 0 || b === 2) v.forEach((m) => push(t, half, m, 54, 'keys'));
          if (b === 1 || b === 3) v.forEach((m) => push(t.add(half), beat, m, 50, 'keys'));
          break;
        case 'alberti': {
          const al = [v[0] - 12, v[2] - 12, v[1] - 12, v[2] - 12];
          for (let k = 0; k < 2; k++) push(t.add(half.mul(k)), half, al[(b * 2 + k) % 4], 50, 'keys');
          break;
        }
        case 'power':
          for (let k = 0; k < 2; k++) [bassNote(ch) + 12, bassNote(ch) + 19].forEach((m) => push(t.add(half.mul(k)), half, m, 60, 'keys'));
          break;
        default:
          if (b === 0) v.forEach((m) => push(t, sp.dur, m, 55, 'keys'));
      }
      // ---- bass ----
      switch (st.bass) {
        case 'walk': {
          const nextSpan = spans[spans.indexOf(sp) + 1];
          const target = nextSpan?.chord && !nextSpan.chord.nc ? bassNote(nextSpan.chord) : bassNote(ch);
          let m;
          if (b === 0) m = bassNote(ch);
          else if (b === nBeats - 1) m = target + (rand() < 0.5 ? -1 : 1);
          else m = bassNote(ch, b);
          push(t, beat, m, 70, 'bass');
          break;
        }
        case 'bossa':
          if (b === 0 || b === 2) push(t, beat.mul(q(3, 2)), bassNote(ch, b === 0 ? 0 : 1), 72, 'bass');
          if (b === 1 || b === 3) push(t.add(half), half, bassNote(ch, b === 1 ? 1 : 0), 64, 'bass');
          break;
        case 'eighths':
          for (let k = 0; k < 2; k++) push(t.add(half.mul(k)), half, bassNote(ch), 70, 'bass');
          break;
        case 'long':
          if (b === 0) push(t, sp.dur, bassNote(ch), 64, 'bass');
          break;
        case 'continuo':
          if (b % 2 === 0) push(t, beat.mul(2), bassNote(ch, b === 2 ? 1 : 0), 62, 'bass');
          break;
        default:
          if (b === 0) push(t, beat.mul(compound ? 1 : 1), bassNote(ch), 72, 'bass');
          if (b === 2 || (compound && b === 1)) push(t, beat, bassNote(ch, 1), 66, 'bass');
          if (b === 1 && !compound) push(t.add(half), half, bassNote(ch), 60, 'bass');
      }
    }
    void isBarStart;
  }
  // ---- drums ----
  if (st.drums) {
    const total = barLen.mul(bars);
    for (let bt = ZERO, i = 0; bt.lt(total); bt = bt.add(beat), i++) {
      const inBar = i % beats;
      const half = beat.div(2);
      switch (st.drums) {
        case 'pop': case 'rock':
          if (inBar === 0 || inBar === 2 || (st.drums === 'rock' && inBar === 2)) push(bt, half, 36, 90, 'drums', 'kick');
          if (st.drums === 'pop' && inBar === 2) push(bt.add(half), half, 36, 70, 'drums', 'kick');
          if (inBar === 1 || inBar === 3) push(bt, half, 38, 82, 'drums', 'snare');
          push(bt, half, 42, 50, 'drums', 'hat'); push(bt.add(half), half, 42, 38, 'drums', 'hat');
          break;
        case 'soft':
          if (inBar === 1 || inBar === 3) push(bt, half, 37, 40, 'drums', 'rim');
          if (inBar === 0) push(bt, half, 36, 50, 'drums', 'kick');
          break;
        case 'shuffle': case 'swing':
          push(bt, half, st.drums === 'swing' ? 51 : 42, 52, 'drums', st.drums === 'swing' ? 'ride' : 'hat');
          push(bt.add(half), half, st.drums === 'swing' ? 51 : 42, 40, 'drums', st.drums === 'swing' ? 'ride' : 'hat');
          if (inBar === 1 || inBar === 3) push(bt, half, st.drums === 'swing' ? 44 : 38, st.drums === 'swing' ? 50 : 76, 'drums', st.drums === 'swing' ? 'pedal' : 'snare');
          if (inBar === 0) push(bt, half, 36, 70, 'drums', 'kick');
          break;
        case 'bossa':
          push(bt, half, 42, 40, 'drums', 'hat'); push(bt.add(half), half, 42, 34, 'drums', 'hat');
          if (inBar === 0 || inBar === 2) push(bt, half, 36, 66, 'drums', 'kick');
          if (inBar === 1 || inBar === 3) push(bt.add(half), half, 36, 56, 'drums', 'kick');
          if ([0, 3].includes(inBar) || (inBar === 1 && i % (beats * 2) < beats)) push(inBar === 1 ? bt.add(half) : bt, half, 37, 56, 'drums', 'rim');
          break;
        default: break;
      }
    }
  }
  return out.sort((a, b) => a.t.cmp(b.t));
}

export { keyName, makeNote, transposeKey, iv, transposeName, spellMidi, formatChord };
