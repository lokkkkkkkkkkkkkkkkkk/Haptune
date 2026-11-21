// Music symbols for buttons, drawn from the engraving font's own outlines (glyphdata.js), and a few marks
// that are lines rather than font characters (slur, tie, hairpins, glissando, barlines, chord boxes).
import { GLYPHS } from './glyphdata.js';

/** One font symbol, centred in a square. */
export function Glyph({ name, size = 22, pad = 60 }) {
  const g = GLYPHS[name];
  if (!g) return null;
  const [d, x, y, w, h] = g;
  const s = Math.max(w, h) + 2 * pad;
  return (
    <svg class="gly" width={size} height={size} viewBox={`${x + w / 2 - s / 2} ${y + h / 2 - s / 2} ${s} ${s}`} aria-hidden="true">
      <path transform="scale(1,-1)" d={d} fill="currentColor" />
    </svg>
  );
}

const FLAGS = { eighth: 'flag8', '16th': 'flag16', '32nd': 'flag32', '64th': 'flag64' };
const RESTS = { whole: 'restWhole', half: 'restHalf', quarter: 'restQuarter', eighth: 'rest8', '16th': 'rest16', '32nd': 'rest32', '64th': 'rest64' };
/** A note value (stem down, as in a palette) or its rest. */
export function NoteIcon({ type = 'quarter', rest = false, size = 28, dots = 0 }) {
  if (rest) return <Glyph name={RESTS[type] || 'restQuarter'} size={size} pad={160} />;
  if (type === 'whole') return dots ? <svg class="gly" width={size} height={size} viewBox="-150 -520 820 1040" aria-hidden="true"><path transform="scale(1,-1)" d={GLYPHS.headWhole[0]} fill="currentColor" /><circle cx={GLYPHS.headWhole[3] + 110} cy="-40" r="50" fill="currentColor" /></svg> : <Glyph name="headWhole" size={size} pad={260} />;
  const head = type === 'half' ? 'headHalf' : 'headBlack';
  const hp = GLYPHS[head];
  const fl = FLAGS[type] && GLYPHS[FLAGS[type]];
  return (
    <svg class="gly" width={size} height={size} viewBox="-230 -200 940 1120" aria-hidden="true">
      <path transform="scale(1,-1)" d={hp[0]} fill="currentColor" />
      <rect x="0" y="10" width="32" height="760" fill="currentColor" />
      {fl && <g transform="translate(0, 770)"><path transform="scale(1,-1)" d={fl[0]} fill="currentColor" /></g>}
      {dots > 0 && <circle cx={hp[3] + 110} cy="-40" r="50" fill="currentColor" />}
    </svg>
  );
}

/** Line marks: slur, tie, hairpins, glissando, barlines, repeat signs, brackets for endings and ottava. */
export function LineIcon({ kind, size = 24 }) {
  const P = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' };
  const body = {
    slur: <path {...P} d="M3 15 Q12 4 21 15" />,
    tie: <><circle cx="5" cy="15" r="2.2" fill="currentColor" /><circle cx="19" cy="15" r="2.2" fill="currentColor" /><path {...P} d="M5 12 Q12 6 19 12" /></>,
    cresc: <path {...P} d="M21 7 L3 12 L21 17" />,
    dim: <path {...P} d="M3 7 L21 12 L3 17" />,
    gliss: <path {...P} d="M3 18 q2 -4 4 -2 t4 -2 t4 -2 t4 -2 t3 -3" />,
    slide: <path {...P} d="M3 17 L21 7" />,
    pedal: <path {...P} d="M3 7 V16 H21 V7" />,
    bar: <path {...P} d="M12 4 V20" />,
    double: <path {...P} d="M10 4 V20 M14 4 V20" />,
    final: <><path {...P} d="M9 4 V20" /><rect x="13" y="4" width="4" height="16" fill="currentColor" /></>,
    repeatStart: <><rect x="5" y="4" width="3.5" height="16" fill="currentColor" /><path {...P} d="M11.5 4 V20" /><circle cx="16" cy="9.5" r="1.7" fill="currentColor" /><circle cx="16" cy="14.5" r="1.7" fill="currentColor" /></>,
    repeatEnd: <><circle cx="8" cy="9.5" r="1.7" fill="currentColor" /><circle cx="8" cy="14.5" r="1.7" fill="currentColor" /><path {...P} d="M12.5 4 V20" /><rect x="15.5" y="4" width="3.5" height="16" fill="currentColor" /></>,
    ending: <path {...P} d="M4 18 V6 H21" />,
    insert: <><path {...P} d="M4 5 V19 M20 5 V19" /><path {...P} d="M12 8 V16 M8 12 H16" /></>,
    remove: <><path {...P} d="M4 5 V19 M20 5 V19" /><path {...P} d="M8 12 H16" /></>,
    triplet: <><path {...P} d="M4 9 V6 H20 V9" /><text x="12" y="20" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor" stroke="none">3</text></>,
    arpUp: <><path {...P} d="M12 21 q-3 -2 0 -4 t0 -4 t0 -4" /><path {...P} d="M9 9 L12 4 L15 9" /></>,
    arpDown: <><path {...P} d="M12 3 q-3 2 0 4 t0 4 t0 4" /><path {...P} d="M9 15 L12 20 L15 15" /></>,
    arpeggio: <path {...P} d="M12 21 q-3 -2 0 -4 t0 -4 t0 -4 t0 -4" />,
    bend: <><path {...P} d="M3 19 H9 Q15 19 16 7" /><path {...P} d="M13 9 L16 5 L19 9" /></>,
  }[kind];
  return <svg class="gly" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">{body}</svg>;
}

/**
 * A chord box: strings across, frets down, dots with finger numbers, x / o above, barre, "5fr" when higher up.
 * d: {strings, frets (low → high, -1 not played), fingers, barre, base}
 */
export function ChordBox({ d, name, size = 76, dark = false }) {
  if (!d) return null;
  const S = d.strings, rows = 4;
  const W = 60, H = 70, x0 = 12, y0 = 22, gw = (W - 2 * 6) / (S - 1), gh = (H - y0 - 6) / rows;
  const X = (i) => x0 + i * gw;
  const Y = (f) => y0 + (f - d.base + 0.5) * gh;
  const ink = dark ? '#fff' : 'currentColor';
  return (
    <svg class="chord-box" width={size} height={size * (H + 12) / (W + 16)} viewBox={`0 ${name ? -12 : 0} ${W + 16} ${H + (name ? 12 : 0)}`} role="img" aria-label={name || 'chord'}>
      {name && <text x={(W + 16) / 2 - 2} y="-1" text-anchor="middle" font-size="12" font-weight="800" fill={ink}>{name}</text>}
      {d.base > 1 ? <text x={x0 + (S - 1) * gw + 5} y={y0 + gh * 0.7} font-size="8.5" font-weight="700" fill={ink}>{d.base}fr</text> : <rect x={x0 - 0.5} y={y0 - 3} width={(S - 1) * gw + 1} height="3" fill={ink} />}
      {Array.from({ length: rows + 1 }, (_, r) => <line key={`r${r}`} x1={x0} x2={x0 + (S - 1) * gw} y1={y0 + r * gh} y2={y0 + r * gh} stroke={ink} stroke-width="0.9" opacity="0.75" />)}
      {Array.from({ length: S }, (_, i) => <line key={`s${i}`} x1={X(i)} x2={X(i)} y1={y0} y2={y0 + rows * gh} stroke={ink} stroke-width="0.9" opacity="0.75" />)}
      {d.barre && <rect x={X(d.barre.from) - 4} y={Y(d.barre.fret) - 4} width={X(d.barre.to) - X(d.barre.from) + 8} height="8" rx="4" fill="var(--brand2, #7B5CF0)" />}
      {d.frets.map((f, i) => (f < 0
        ? <text key={i} x={X(i)} y={y0 - 6} text-anchor="middle" font-size="8.5" font-weight="700" fill={ink}>×</text>
        : f === 0 ? <circle key={i} cx={X(i)} cy={y0 - 9} r="2.6" fill="none" stroke={ink} stroke-width="1" />
          : (d.barre && f === d.barre.fret && i >= d.barre.from && i <= d.barre.to && d.fingers[i] === 1) ? null
            : <g key={i}><circle cx={X(i)} cy={Y(f)} r="4.6" fill="var(--brand2, #7B5CF0)" />{d.fingers[i] ? <text x={X(i)} y={Y(f) + 3} text-anchor="middle" font-size="7" font-weight="800" fill="#fff">{d.fingers[i]}</text> : null}</g>))}
    </svg>
  );
}
