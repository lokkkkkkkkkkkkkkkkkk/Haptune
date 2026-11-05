// Shared building blocks: icons, cards, lists, controls, charts, staff, keyboard and chord diagrams.
import { useState, useEffect, useRef } from 'preact/hooks';
import { GLYPHS } from './glyphs.js';
import { STEPS, keyAlter, midiOf, nameOf } from '../core/pitch.js';
import { fretShapes, TUNINGS, pianoVoicing, formatChord, chordPcs, rootPc } from '../core/chords.js';

// ---------- icons (24×24, stroke) ----------
const P = {
  summary: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM7.5 12.5h2l1.2-3 2.2 6 1.4-3h2.2',
  library: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM9 10l10-2',
  academy: 'M2.5 9 12 4.5 21.5 9 12 13.5zM6.5 11v4.5c1.6 1.6 3.4 2.4 5.5 2.4s3.9-.8 5.5-2.4V11M21.5 9v5',
  improvise: 'M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7zM18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8zM6 15.5l.6 1.4 1.4.6-1.4.6L6 19.5l-.6-1.4-1.4-.6 1.4-.6z',
  sparkles: 'M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7zM18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  tools: 'M10 4v6a2 2 0 0 0 4 0V4M12 12v8M8 4v5M16 4v5',
  tuningfork: 'M10 4v6a2 2 0 0 0 4 0V4M12 12v8',
  plus: 'M12 5v14M5 12h14', close: 'M6 6l12 12M18 6 6 18', check: 'M5 12.5l4.5 4.5L19 7.5',
  chevronR: 'M9.5 6l6 6-6 6', chevronL: 'M14.5 6l-6 6 6 6', chevronD: 'M6 9.5l6 6 6-6', chevronU: 'M6 14.5l6-6 6 6',
  play: 'M8 5.5v13l11-6.5z', pause: 'M8 5.5v13M16 5.5v13', stop: 'M6.5 6.5h11v11h-11z',
  loop: 'M17 2.5l3 3-3 3M4 11V9.5a4 4 0 0 1 4-4h12M7 21.5l-3-3 3-3M20 13v1.5a4 4 0 0 1-4 4H4',
  metronome: 'M9 3.5h6l3.5 17h-13zM12 15.5l5-9M7 15.5h10',
  mic: 'M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z',
  trash: 'M4.5 7h15M10 11v6M14 11v6M6 7l1 12.5h10L18 7M9 7V4.5h6V7',
  share: 'M12 15V3.5M8 7.5l4-4 4 4M5.5 11.5v8h13v-8',
  search: 'M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM15.5 15.5 20 20',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c1-3.6 4-5.5 7.5-5.5s6.5 1.9 7.5 5.5',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  flame: 'M12 21c3.6 0 6-2.4 6-5.8 0-3.4-2.6-5.3-3.6-8.7-.4 1.9-1.4 3.1-2.6 3.8.2-2.9-1-5.6-3.4-7.3.3 3.5-4.4 6.3-4.4 11.2C4 18.6 7.4 21 12 21z',
  trophy: 'M7 4.5h10v4a5 5 0 0 1-10 0zM7 6.5H4.5a2.5 2.5 0 0 0 2.5 4M17 6.5h2.5a2.5 2.5 0 0 1-2.5 4M12 13.5v3.5M8.5 20.5h7M9.5 17h5v3.5h-5z',
  ear: 'M7 9a5 5 0 1 1 10 0c0 3-3 4-3 6.5a3 3 0 0 1-5.6 1.5M10 9.5a2 2 0 0 1 4 0',
  chords: 'M5 4.5v15M9.5 4.5v15M14 4.5v15M18.5 4.5v15M5 8.5h13.5M5 12.5h13.5M9.5 10.5a1 1 0 1 0 0 .1M14 14.5a1 1 0 1 0 0 .1',
  staff: 'M3.5 7h17M3.5 10h17M3.5 13h17M3.5 16h17M3.5 19h17M14 18.5a2 1.5 0 1 1-4 0 2 1.5 0 0 1 4 0zM14 18.5V8',
  key: 'M8 14.5a4.5 4.5 0 1 1 3.9-6.7H21v3h-2v2.5h-3v-2.5h-4.1A4.5 4.5 0 0 1 8 14.5z',
  arrowUp: 'M12 19V5M6 11l6-6 6 6', arrowDown: 'M12 5v14M6 13l6 6 6-6', arrows: 'M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4',
  doc: 'M7 3.5h7l4.5 4.5v12.5h-11.5zM14 3.5V8h4.5', folder: 'M3.5 6.5h6l2 2h9v10h-17z', link: 'M10 14l4-4M8.5 16.5l-1.5 1.5a3.5 3.5 0 0 1-5-5L5.5 9.5a3.5 3.5 0 0 1 5 0M13.5 14.5a3.5 3.5 0 0 0 5 0l3.5-3.5a3.5 3.5 0 0 0-5-5L15.5 7.5',
  paste: 'M9 4.5h6v2.5H9zM15 5.5h3.5v15h-13v-15H9M8.5 12h7M8.5 15.5h5',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z',
  stairs: 'M4 20h4v-4h4v-4h4V8h4V4', book: 'M4.5 5.5c2.5-1 5-1 7.5.5 2.5-1.5 5-1.5 7.5-.5v13c-2.5-1-5-1-7.5.5-2.5-1.5-5-1.5-7.5-.5zM12 6v13',
  piano: 'M3.5 5.5h17v13h-17zM7.5 5.5v8M11 5.5v8M14.5 5.5v8M18 5.5v8M5.5 13.5v5M9.5 13.5v5M13 13.5v5M16.5 13.5v5',
  guitar: 'M14.5 9.5l5-5M18 3l3 3M10 9a5 5 0 0 0-6.5 6.5 5 5 0 0 0 6.5 4.5 5 5 0 0 0 4.5-6.5 4 4 0 0 0-4.5-4.5zM8.5 15.5a1.5 1.5 0 1 0 0-.1',
  wifi: 'M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0M12 19.5v.1',
  cloud: 'M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.5 3.75 3.75 0 0 1-.4 7.5z',
  crown: 'M4 17.5h16M5 15l-1.5-8.5 5 3.5L12 4.5l3.5 5.5 5-3.5L19 15z', flag: 'M5.5 21V4.5M5.5 5h12l-2.5 4 2.5 4h-12',
  books: 'M4.5 4.5h4v15h-4zM8.5 4.5h4v15h-4zM13 5.2l3.8-1 3.8 14.6-3.8 1z', info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.5v.1', quiz: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6M12 16.6v.1',
  wand: 'M4 20 15 9M14 4v3M19 9h-3M17.5 5.5l-2 2M18.5 13.5l-1.5-1.5', drone: 'M3 12h3l2-5 3 10 3-8 2 3h5',
  speaker: 'M4.5 9.5h3.5l4.5-4v13l-4.5-4H4.5zM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12',
  download: 'M12 3.5V15M7.5 10.5 12 15l4.5-4.5M5.5 19.5h13', bolt: 'M13 2.5 5 13.5h6l-1 8 8-11h-6z', moon: 'M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z',
  pencil: 'M4.5 19.5l1-4.5 10.5-10.5 3.5 3.5L9 18.5zM14 6.5l3.5 3.5',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  video: 'M3.5 7.5a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3zM10 9v6l5-3z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  watch: 'M8 6.5h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM9 6.5l1-3h4l1 3M9 17.5l1 3h4l1-3',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.9-3.4 3.4-5.5 6.5-5.5s5.6 2.1 6.5 5.5M16.5 11.5a3 3 0 1 0 0-6M17.5 14.5c2.2.4 3.6 2.4 4 5.5',
  minus: 'M5 12h14', skipBack: 'M6 5.5v13M18 6l-9 6 9 6z', skipFwd: 'M18 5.5v13M6 6l9 6-9 6z',
  heart: 'M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z',
  send: 'M4 11.5 20 4l-6.5 16-2.5-6.5z', copy: 'M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4',
  calendar: 'M4.5 6.5h15v13h-15zM4.5 10.5h15M8.5 4v4M15.5 4v4', print: 'M7 9V4h10v5M7 17H5v-7h14v7h-2M7 14h10v6H7z',
  violin: 'M15 9l5.5-5.5M18.5 3l2.5 2.5M9.5 9.5c-2-2-5-1.5-6 .5s0 3 1.5 3.5c-1.5 1-1.5 3.5.5 5s4.5 1.5 5.5-.5c.5 1.5 2.5 2.5 4 1 1.5-1.5 1-4.5-1-6.5z',
};

export function Icon({ name, size = 22, stroke = 1.9, fill = false, color, style }) {
  const d = P[name] || P.info;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0, color, ...style }}>
      <path d={d} fill={fill ? 'currentColor' : 'none'} stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** Coloured rounded-square icon, like the Health app's category badges. */
export function Badge({ icon, color = 'blue', size = 30, solid = true }) {
  return (
    <span class={`badge c-${color}${solid ? ' solid' : ''}`} style={{ width: size, height: size, borderRadius: size * 0.26 }}>
      <Icon name={icon} size={size * 0.62} stroke={2.1} />
    </span>
  );
}

export function Card({ children, class: cls = '', onClick, style }) {
  const Tag = onClick ? 'button' : 'div';
  return <Tag class={`card ${cls}`} onClick={onClick} style={style} type={onClick ? 'button' : undefined}>{children}</Tag>;
}

export function CardHead({ icon, color, title, detail, chevron = true }) {
  return (
    <div class="card-head">
      <span class={`card-title t-${color}`}><Icon name={icon} size={17} stroke={2.2} />{title}</span>
      <span class="card-detail">{detail}{chevron && <Icon name="chevronR" size={14} stroke={2.4} />}</span>
    </div>
  );
}

export function BigValue({ value, unit }) {
  return <div class="big-value"><span class="num">{value}</span>{unit && <span class="unit">{unit}</span>}</div>;
}

export function Section({ title, footer, children, action }) {
  return (
    <section class="section">
      {(title || action) && <div class="section-head"><h2>{title}</h2>{action}</div>}
      {children}
      {footer && <p class="section-foot">{footer}</p>}
    </section>
  );
}

export function List({ children, inset = true }) { return <div class={`list${inset ? ' inset' : ''}`}>{children}</div>; }

export function Row({ icon, color, title, subtitle, detail, onClick, chevron, right, danger, children, id }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag class={`row${danger ? ' danger' : ''}`} onClick={onClick} type={onClick ? 'button' : undefined} id={id}>
      {icon && <Badge icon={icon} color={color} size={30} />}
      <span class="row-main">
        <span class="row-title">{title}</span>
        {subtitle && <span class="row-sub">{subtitle}</span>}
        {children}
      </span>
      {detail !== undefined && detail !== null && <span class="row-detail">{detail}</span>}
      {right}
      {(chevron ?? !!onClick) && <Icon name="chevronR" size={15} stroke={2.4} style={{ opacity: 0.35 }} />}
    </Tag>
  );
}

export function Toggle({ checked, onChange, label, id }) {
  return (
    <label class="toggle" for={id}>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} aria-label={label} />
      <span class="track"><span class="thumb" /></span>
    </label>
  );
}

export function Segmented({ value, options, onChange, small, id }) {
  return (
    <div class={`segmented${small ? ' small' : ''}`} role="tablist" id={id}>
      {options.map((o) => (
        <button type="button" role="tab" aria-selected={o.value === value} class={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} key={o.value}>{o.label}</button>
      ))}
    </div>
  );
}

export function Chip({ children, on, onClick, color }) {
  return <button type="button" class={`chip${on ? ' on' : ''}${color ? ' c-' + color : ''}`} onClick={onClick}>{children}</button>;
}

export function Button({ children, kind = 'primary', onClick, disabled, icon, color, full, small, type = 'button' }) {
  return (
    <button type={type} class={`btn ${kind}${full ? ' full' : ''}${small ? ' small' : ''}${color ? ' c-' + color : ''}`} onClick={onClick} disabled={disabled}>
      {icon && <Icon name={icon} size={small ? 16 : 19} stroke={2.2} />}{children}
    </button>
  );
}

export function Stepper({ value, onDec, onInc, label, sub }) {
  return (
    <div class="stepper">
      <button type="button" onClick={onDec} aria-label="−"><Icon name="arrowDown" size={18} stroke={2.3} /></button>
      <div class="stepper-mid"><span class="stepper-label">{label}</span><strong>{value}</strong>{sub && <span class="stepper-sub">{sub}</span>}</div>
      <button type="button" onClick={onInc} aria-label="+"><Icon name="arrowUp" size={18} stroke={2.3} /></button>
    </div>
  );
}

// ---------- charts ----------

/** Apple-Watch-style activity rings: rings = [{value 0..n, color}] (values over 1 wrap). */
export function Rings({ rings, size = 120, width = 13 }) {
  const gap = 2.5;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} class="rings" aria-hidden="true">
      {rings.map((r, i) => {
        const rad = size / 2 - width / 2 - i * (width + gap);
        const circ = 2 * Math.PI * rad;
        const v = Math.max(0, r.value);
        const frac = Math.min(v, 1);
        return (
          <g key={i} transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            <circle cx={size / 2} cy={size / 2} r={rad} class={`ring-bg s-${r.color}`} stroke-width={width} fill="none" />
            <circle cx={size / 2} cy={size / 2} r={rad} class={`ring-fg s-${r.color}`} stroke-width={width} fill="none" stroke-linecap="round"
              stroke-dasharray={`${Math.max(0.001, frac * circ)} ${circ}`} />
            {v > 1 && <circle cx={size / 2} cy={size / 2} r={rad} class={`ring-fg s-${r.color}`} stroke-width={width} fill="none" stroke-linecap="round" stroke-dasharray={`${Math.min(1, v - 1) * circ} ${circ}`} style={{ filter: 'brightness(1.15)' }} />}
          </g>
        );
      })}
    </svg>
  );
}

export function MiniBars({ values, highlightLast = true, color = 'pink', width = 120, height = 44 }) {
  const max = Math.max(1, ...values);
  const bw = width / values.length;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {values.map((v, i) => {
        const h = Math.max(2, (v / max) * (height - 2));
        return <rect key={i} x={i * bw + bw * 0.18} y={height - h} width={bw * 0.64} height={h} rx={2} class={`f-${color}`} opacity={highlightLast && i === values.length - 1 ? 1 : 0.38} />;
      })}
    </svg>
  );
}

export function MiniLine({ values, color = 'green', width = 120, height = 44, min = 40, max = 100 }) {
  if (values.length < 2) return null;
  const x = (i) => 4 + (i / (values.length - 1)) * (width - 8);
  const y = (v) => height - 4 - ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * (height - 8);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={`${d}L${x(values.length - 1)},${height}L${x(0)},${height}Z`} class={`f-${color}`} opacity="0.13" />
      <path d={d} fill="none" class={`s-${color}`} stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="3.6" class={`f-${color}`} />
    </svg>
  );
}

export function Stars({ n, max = 5 }) {
  return <span class="stars" aria-label={`${n}/${max}`}>{Array.from({ length: max }, (_, i) => <span key={i} class={i < n ? 'on' : ''}>●</span>)}</span>;
}

// ---------- small staff for quizzes ----------

const SHARP_POS_T = ['F5', 'C5', 'G5', 'D5', 'A4', 'E5', 'B4'];
const FLAT_POS_T = ['B4', 'E5', 'A4', 'D5', 'G4', 'C5', 'F4'];
const di = (p) => p.octave * 7 + STEPS.indexOf(p.step);
const parsePos = (s) => ({ step: s[0], octave: Number(s[1]) });

/** Draws a staff with a clef, optional key signature, and notes or rhythm values. */
export function MiniStaff({ clef = 'G', notes = [], keySig = 0, rhythm = null, height = 120 }) {
  const sp = height / 12; // staff space
  const k = sp / 250;
  const top = sp * 4;
  const bottomLine = clef === 'F' ? di({ step: 'G', octave: 2 }) : di({ step: 'E', octave: 4 });
  const yOf = (p) => top + 4 * sp - (di(p) - bottomLine) * (sp / 2);
  const glyph = (name, x, y, cls = '') => <path class={cls} transform={`translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${k},${-k})`} d={GLYPHS[name]} />;
  const items = [];
  let x = sp * 1.2;
  items.push(glyph(clef === 'F' ? 'fClef' : 'gClef', x, clef === 'F' ? top + sp : top + 3 * sp));
  x += sp * 3.4;
  const shift = clef === 'F' ? -14 : 0;
  if (keySig) {
    const pos = keySig > 0 ? SHARP_POS_T : FLAT_POS_T;
    for (let i = 0; i < Math.abs(keySig); i++) {
      const p = parsePos(pos[i]);
      const y = yOf({ step: p.step, octave: p.octave + shift / 7 });
      items.push(glyph(keySig > 0 ? 'sharp' : 'flat', x, y));
      x += sp * 1.05;
    }
    x += sp * 0.6;
  }
  x += sp * 1.2;
  const lines = [0, 1, 2, 3, 4].map((i) => <line key={i} x1={sp * 0.6} x2="100%" y1={top + i * sp} y2={top + i * sp} class="staff-line" />);
  if (rhythm) {
    for (const r of rhythm) {
      const y = top + 2 * sp;
      const head = r.type === 'whole' ? 'noteWhole' : r.type === 'half' ? 'noteHalf' : 'noteBlack';
      items.push(glyph(head, x, y, 'nh'));
      if (r.type !== 'whole') items.push(<line x1={x + sp * 1.13} x2={x + sp * 1.13} y1={y - 0.1 * sp} y2={y - 3.5 * sp} class="stem" />);
      if (r.type === 'eighth') items.push(glyph('flag8Up', x + sp * 1.06, y - 3.5 * sp));
      if (r.dots) items.push(<circle cx={x + sp * 1.7} cy={y - sp * 0.5} r={sp * 0.2} class="dot" />);
      x += sp * 4;
    }
  }
  for (const p of notes) {
    const y = yOf(p);
    // ledger lines
    const d = di(p) - bottomLine;
    for (let l = -2; l >= d; l -= 2) items.push(<line x1={x - sp * 0.4} x2={x + sp * 1.6} y1={top + 4 * sp - (l / 2) * sp} y2={top + 4 * sp - (l / 2) * sp} class="staff-line" />);
    for (let l = 10; l <= d; l += 2) items.push(<line x1={x - sp * 0.4} x2={x + sp * 1.6} y1={top + 4 * sp - (l / 2) * sp} y2={top + 4 * sp - (l / 2) * sp} class="staff-line" />);
    if (p.alter && p.alter !== keyAlter(keySig, p.step)) items.push(glyph(p.alter > 0 ? 'sharp' : 'flat', x - sp * 1.4, y));
    items.push(glyph('noteWhole', x, y, 'nh'));
    x += sp * 3.5;
  }
  return (
    <svg class="mini-staff" width="100%" height={height} viewBox={`0 0 ${Math.max(x + sp * 2, sp * 16)} ${height}`} preserveAspectRatio="xMinYMid meet" role="img">
      {lines}
      {items}
    </svg>
  );
}

// ---------- keyboard ----------
const BLACK = [1, 3, 6, 8, 10];
/** Piano keys from lo to hi (MIDI). marks: Map(midi -> class) */
export function Keyboard({ lo = 48, hi = 72, marks = new Map(), onKey, labels = false, height = 92 }) {
  const whites = [];
  for (let m = lo; m <= hi; m++) if (!BLACK.includes(((m % 12) + 12) % 12)) whites.push(m);
  const ww = 100 / whites.length;
  const keys = [];
  whites.forEach((m, i) => {
    keys.push(
      <button type="button" key={m} class={`wkey ${marks.get(m) || ''}`} style={{ left: `${i * ww}%`, width: `${ww}%` }} onClick={() => onKey?.(m)} aria-label={nameOf({ step: STEPS[[0, 2, 4, 5, 7, 9, 11].indexOf(m % 12)], alter: 0 }) + (Math.floor(m / 12) - 1)}>
        {labels && m % 12 === 0 && <span>C{Math.floor(m / 12) - 1}</span>}
      </button>,
    );
  });
  whites.forEach((m, i) => {
    const b = m + 1;
    if (b <= hi && BLACK.includes(b % 12)) {
      keys.push(<button type="button" key={b} class={`bkey ${marks.get(b) || ''}`} style={{ left: `${(i + 0.68) * ww}%`, width: `${ww * 0.64}%` }} onClick={() => onKey?.(b)} aria-label={`key ${b}`} />);
    }
  });
  return <div class="keyboard" style={{ height }}>{keys}</div>;
}

// ---------- chord diagrams ----------
export function FretDiagram({ chord, instrument = 'guitar', index = 0, width = 112 }) {
  const shapes = fretShapes(chord, instrument, 3);
  const s = shapes[index] || shapes[0];
  const tun = TUNINGS[instrument];
  if (!s) return <div class="fret-none">—</div>;
  const n = tun.strings.length;
  const base = s.base || 1;
  const frets = 5;
  const W = width, H = width * 1.25;
  const left = 14, right = W - 10, topY = 26, bottomY = H - 12;
  const sx = (i) => left + (i * (right - left)) / (n - 1);
  const fy = (f) => topY + ((f - base + 0.5) * (bottomY - topY)) / frets;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} class="fret" role="img" aria-label={formatChord(chord)}>
      {base === 1 ? <rect x={left - 1} y={topY - 4} width={right - left + 2} height={4} class="nut" /> : <text x={2} y={fy(base) + 4} class="fret-base">{base}</text>}
      {Array.from({ length: frets + 1 }, (_, f) => <line key={'f' + f} x1={left} x2={right} y1={topY + (f * (bottomY - topY)) / frets} y2={topY + (f * (bottomY - topY)) / frets} class="fret-line" />)}
      {Array.from({ length: n }, (_, i) => <line key={'s' + i} x1={sx(i)} x2={sx(i)} y1={topY} y2={bottomY} class="fret-line" />)}
      {s.barre && <rect x={sx(s.barre.from) - 6} y={fy(s.barre.fret) - 6} width={sx(s.barre.to) - sx(s.barre.from) + 12} height={12} rx={6} class="fret-dot" />}
      {s.frets.map((f, i) => (f < 0
        ? <text key={i} x={sx(i)} y={topY - 9} class="fret-mark" text-anchor="middle">×</text>
        : f === 0 ? <circle key={i} cx={sx(i)} cy={topY - 13} r={4} class="fret-open" />
          : <circle key={i} cx={sx(i)} cy={fy(f)} r={6} class="fret-dot" />))}
    </svg>
  );
}

export function PianoChord({ chord }) {
  const notes = pianoVoicing(chord, 4);
  const lo = Math.min(...notes) - (Math.min(...notes) % 12);
  const marks = new Map(notes.map((m) => [m, m % 12 === rootPc(chord) ? 'mark-root' : 'mark']));
  return <Keyboard lo={lo} hi={lo + 23} marks={marks} height={70} />;
}

export function useInterval(fn, ms, deps = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => { if (ms === null) return undefined; const id = setInterval(() => ref.current(), ms); return () => clearInterval(id); }, [ms, ...deps]);
}

export function Empty({ icon, title, sub, children }) {
  return <div class="empty"><Badge icon={icon} color="gray" size={54} solid={false} /><h3>{title}</h3>{sub && <p>{sub}</p>}{children}</div>;
}

export { useState, chordPcs, midiOf };
