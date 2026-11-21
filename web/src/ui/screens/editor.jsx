// The note editor: fix a score note by note. Made for putting right what the AI reader got wrong (the bars it
// marked come first), and just as good for writing a score for someone on Stage.
//
// A few bars are shown at a time, large, so every edit redraws at once. Tap a note or rest, then use the
// buttons: move it by step or semitone, make it a rest or a note, split it in two, join it to the next,
// add a chord note. Bars always stay full. Changes are saved as you go; Undo steps back.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp, getPiece, updatePiece, toast } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, Chip } from '../components.jsx';
import { NavBar } from './common.jsx';
import { renderMusicXML, warmEditor } from '../verovio.js';
import { writeMusicXML } from '../../core/musicxml.js';
import { findNote, movePitch, toRest, toNote, splitNote, joinNext, addChordNote, sliceMeasures } from '../../core/edit.js';
import { performance as perfOf, secondsAt, keyAt } from '../../core/score.js';
import { midiOf, pitchName } from '../../core/pitch.js';
import { audioContext, note, Transport } from '../audio.js';
import { soundOf } from '../../core/instruments.js';
import { difficulty } from '../../core/analysis.js';
import { issueLines } from '../readflags.js';
import { nextNote, prevNote, naturalize, toggleTie, toggleMark, hasMark } from '../../core/notation.js';
import { Glyph, LineIcon } from '../glyphs.jsx';

const TYPE_LABEL = { whole: '𝅝', half: '𝅗𝅥', quarter: '♩', eighth: '♪', '16th': '𝅘𝅥𝅯', '32nd': '𝅘𝅥𝅰' };

export function EditorView({ id, bar = 0, onSaved, active }) {
  const s = useApp();
  const meta = s.pieces.find((p) => p.id === id);
  const [hist, setHist] = useState({ list: [], i: -1 });
  const [flags, setFlags] = useState([]);
  const [win, setWin] = useState(0);
  const [selId, setSel] = useState(null);
  const [svg, setSvg] = useState('');
  const [wide, setWide] = useState(false);
  const boxRef = useRef(null);
  const saveTimer = useRef(null);
  const dirty = useRef(false);
  const transport = useRef(null);
  const score = hist.i >= 0 ? hist.list[hist.i] : null;
  const N = wide ? 4 : 2;

  useEffect(() => {
    warmEditor();
    getPiece(id).then((d) => {
      if (!d?.score) return;
      setHist({ list: [d.score], i: 0 });
      setFlags(d.rec.aiFlags || []);
      const w = (boxRef.current?.clientWidth || 360) > 640;
      setWide(w);
      const n = w ? 4 : 2;
      setWin(Math.max(0, Math.min(d.score.measures.length - 1, bar) - (bar % n)));
    });
    return () => { transport.current?.stop(); };
  }, [id]);

  // draw the bars in view
  const slice = useMemo(() => (score ? sliceMeasures(score, win, win + N - 1) : null), [score, win, N]);
  useEffect(() => {
    if (!slice) return undefined;
    let alive = true;
    const width = Math.min(900, boxRef.current?.clientWidth || 360);
    renderMusicXML(writeMusicXML(slice), { width, scale: width < 500 ? 52 : 58, lane: 'edit', key: 'editor' }).then((r) => { if (alive) setSvg(r.pages.join('')); }).catch((e) => { if (alive && !e.superseded) setSvg(''); });
    return () => { alive = false; };
  }, [slice]);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.querySelectorAll('.sel').forEach((el) => el.classList.remove('sel'));
    if (selId) box.querySelector(`[id="${selId}"]`)?.classList.add('sel');
    const ms = box.querySelectorAll('g.measure');
    flags.forEach((f) => { const k = f.bar - 1 - win; if (k >= 0 && k < N) ms[k]?.classList.add('flagged'); });
  }, [svg, selId, flags]);

  // save a moment after each change, and when leaving
  const save = (sc = score, fl = flags) => {
    if (!sc || !dirty.current) return;
    dirty.current = false;
    updatePiece(id, { xml: writeMusicXML(sc), measures: sc.measures.length, aiFlags: fl, difficulty: difficulty(sc) }).then(() => onSaved?.());
  };
  const latest = useRef({});
  latest.current = { score, flags, save };
  useEffect(() => () => { clearTimeout(saveTimer.current); latest.current.save(latest.current.score, latest.current.flags); }, []);
  useEffect(() => { if (!active) { transport.current?.stop(); latest.current.save(latest.current.score, latest.current.flags); } }, [active]);
  const changed = (next, fl = flags) => {
    dirty.current = true;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => latest.current.save(next, fl), 900);
  };

  const loc = score && selId ? findNote(score, selId) : null;
  const apply = (fn, keepSel = true) => {
    if (!score || !selId) { toast(t('edHint')); return; }
    const out = fn(score, selId);
    const next = out?.score || out;
    if (!next || next === score) { toast(t('edCant'), 'err'); return; }
    setHist((h) => ({ list: [...h.list.slice(0, h.i + 1), next].slice(-60), i: Math.min(h.i + 1, 59) }));
    if (out?.id) setSel(out.id); else if (!keepSel || !findNote(next, selId)) setSel(null);
    changed(next);
    // let the ear check the new note
    const n = findNote(next, out?.id || selId)?.note;
    if (n?.pitch) { const ctx = audioContext(); const part = next.parts[findNote(next, out?.id || selId).pi]; if (ctx) note(ctx.currentTime + 0.02, midiOf(n.pitch) + (part.transpose?.c || 0), 0.5, 84, soundOf(part.instrument)); }
  };
  const undo = () => { if (hist.i > 0) { setHist((h) => ({ ...h, i: h.i - 1 })); changed(hist.list[hist.i - 1]); } };
  const redo = () => { if (hist.i < hist.list.length - 1) { setHist((h) => ({ ...h, i: h.i + 1 })); changed(hist.list[hist.i + 1]); } };

  /** The note or rest that was tapped. Rests the engraver gave its own ids are found by their place in the bar. */
  const onClick = (e) => {
    let g = e.target.closest?.('g.note, g.rest, g.mRest');
    if (!g && boxRef.current) {
      // a finger rarely lands exactly on a note head: take the nearest note or rest within reach
      let best = 40;
      for (const el of boxRef.current.querySelectorAll('g.note, g.rest, g.mRest')) {
        const r = (el.querySelector('.notehead') || el).getBoundingClientRect();
        const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        if (d < best) { best = d; g = el; }
      }
    }
    if (!g || !score) { setSel(null); return; }
    if (g.id && findNote(score, g.id)) { setSel(g.id); return; }
    const box = boxRef.current;
    const measure = g.closest('g.measure'), staff = g.closest('g.staff'), layer = g.closest('g.layer');
    if (!measure || !staff || !layer) return;
    const mi = win + [...box.querySelectorAll('g.measure')].indexOf(measure);
    const staffNo = [...measure.querySelectorAll('g.staff')].indexOf(staff);
    let k = staffNo, pi = 0;
    while (pi < score.parts.length && k >= (score.parts[pi].staves || 1)) { k -= score.parts[pi].staves || 1; pi++; }
    const pm = score.parts[pi]?.measures[mi];
    if (!pm) return;
    const onStaff = pm.notes.filter((n) => (n.staff || 1) === k + 1);
    const voices = [...new Set(onStaff.map((n) => n.voice))].sort();
    const voice = voices[[...staff.querySelectorAll('g.layer')].indexOf(layer)] ?? voices[0];
    const rests = onStaff.filter((n) => n.rest && n.voice === voice);
    const idx = [...layer.querySelectorAll('g.rest, g.mRest')].indexOf(g);
    if (rests[idx]) setSel(rests[idx].id);
  };

  // step to the next / previous note or rest (exact, without tapping), moving the bars in view with it
  const stepSel = (d) => {
    if (!score) return;
    let target = null;
    if (!selId) {
      const pm = score.parts[0]?.measures[win];
      const first = pm?.notes.filter((x) => !x.chord && !x.grace).sort((a, b) => (a.staff || 1) - (b.staff || 1) || a.off.cmp(b.off))[0];
      if (first) target = { note: first, mi: win };
    } else target = (d > 0 ? nextNote : prevNote)(score, selId, { rests: true });
    if (!target) return;
    setSel(target.note.id);
    if (target.mi < win || target.mi >= win + N) setWin(target.mi - (target.mi % N));
    if (target.note.pitch) { const ctx = audioContext(); if (ctx) note(ctx.currentTime + 0.02, midiOf(target.note.pitch), 0.4, 80, soundOf(score.parts[0]?.instrument)); }
  };
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (/input|textarea|select/i.test(e.target?.tagName || '')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); stepSel(1); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepSel(-1); return; }
      if (e.key === 'ArrowUp' && selId) { e.preventDefault(); apply((sc, i) => movePitch(sc, i, e.shiftKey ? 'octaveUp' : 'up')); return; }
      if (e.key === 'ArrowDown' && selId) { e.preventDefault(); apply((sc, i) => movePitch(sc, i, e.shiftKey ? 'octaveDown' : 'down')); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const hear = () => {
    if (!slice) return;
    audioContext();
    if (!transport.current) transport.current = new Transport();
    const tr = transport.current;
    if (tr.playing) { tr.stop(); return; }
    const perf = perfOf(slice, { repeats: false });
    const evs = perf.events.map((e) => { const a = secondsAt(perf.tempos, e.t); return { time: a, dur: secondsAt(perf.tempos, e.t.add(e.dur)) - a, midi: e.midi, vel: 82, inst: soundOf(slice.parts[e.pi]?.instrument) }; });
    tr.load(evs, secondsAt(perf.tempos, perf.length) + 0.3);
    tr.setLoop(null);
    tr.play(0);
  };

  const total = score?.measures.length || 0;
  const go = (d) => { setSel(null); setWin((w) => Math.max(0, Math.min(Math.max(0, total - 1 - ((total - 1) % N)), w + d * N))); };
  const here = flags.filter((f) => f.bar - 1 >= win && f.bar - 1 < win + N);
  const checked = () => { const fl = flags.filter((f) => !here.includes(f)); setFlags(fl); dirty.current = true; changed(score, fl); toast(t('edCheckedDone')); };
  const n = loc?.note;
  const key = loc ? keyAt(loc.part, loc.mi) : null;
  const info = !n ? t('edHint') : n.rest ? `${t('edRestWord')} ${TYPE_LABEL[n.type] || ''} · ${t('bar', { n: loc.mi + 1 })}`
    : `${pitchName(n.pitch)} ${TYPE_LABEL[n.type] || ''}${n.dots ? '.' : ''} · ${t('bar', { n: loc.mi + 1 })}`;
  void key;
  const B = ({ icon, label, short, onClick: fn, text, g, line, id: bid, off, on }) => (
    <button type="button" class={`ed-b${on ? ' on' : ''}`} id={bid} onClick={fn} disabled={off} aria-label={label} title={label}>
      {g ? <Glyph name={g} size={24} /> : line ? <LineIcon kind={line} size={22} /> : text ? <span class="tx">{text}</span> : <Icon name={icon} size={20} stroke={2.2} />}<span class="lb">{short || label}</span>
    </button>
  );
  if (!meta) return <div class="scroll"><NavBar title={t('editNotes')} /></div>;
  return (
    <div class="scroll has-editor" id="editor">
      <NavBar title={t('editNotes')} backLabel={t('done')} actions={<>
        <button type="button" onClick={undo} disabled={hist.i <= 0} aria-label={t('edUndo')} id="ed-undo" style={hist.i <= 0 ? { opacity: 0.35 } : null}><Icon name="skipBack" size={21} /></button>
        <button type="button" onClick={redo} disabled={hist.i >= hist.list.length - 1} aria-label={t('edRedo')} style={hist.i >= hist.list.length - 1 ? { opacity: 0.35 } : null}><Icon name="skipFwd" size={21} /></button>
      </>} />
      <div class="wrap" style={{ paddingTop: 10 }}>
        <div class="ed-nav">
          <button type="button" class="tbtn" onClick={() => go(-1)} disabled={win <= 0} aria-label="−"><Icon name="chevronL" size={20} stroke={2.6} /></button>
          <strong class="num" id="ed-bars">{t('edBars', { a: win + 1, b: Math.min(total, win + N), n: total })}</strong>
          <button type="button" class="tbtn" onClick={() => go(1)} disabled={win + N >= total} aria-label="+"><Icon name="chevronR" size={20} stroke={2.6} /></button>
          <button type="button" class="ptag" onClick={hear} id="ed-hear"><Icon name="speaker" size={16} />{t('edHear')}</button>
        </div>
        {flags.length > 0 && (
          <div class="chips">
            <span class="sub" style={{ alignSelf: 'center', fontWeight: 700 }}>{t('edToCheck')}</span>
            {flags.slice(0, 40).map((f) => <Chip key={f.bar} color={(f.level || 'check') === 'check' ? 'orange' : 'gray'} on={here.includes(f)} onClick={() => { setSel(null); setWin(Math.max(0, f.bar - 1 - ((f.bar - 1) % N))); }}>{f.bar}</Chip>)}
          </div>
        )}
        {here.length > 0 && (
          <div class="banner warn"><Icon name="info" size={18} stroke={2.2} /><div class="sub" style={{ flex: 1 }}>{here.map((f) => (f.unread ? t('edUnread', { n: f.bar }) : `${t('bar', { n: f.bar })}: ${issueLines(f).map((x) => (x.where ? `${x.where}: ${x.text}` : x.text)).join('; ')}`)).join(' · ')}</div>
            <button type="button" class="ptag" onClick={checked} id="ed-checked"><Icon name="check" size={15} stroke={2.6} />{t('edChecked')}</button></div>
        )}
        <div class="score-box vrv ed-score" ref={boxRef} onClick={onClick} dangerouslySetInnerHTML={{ __html: svg }} />
        {!svg && <div class="loading"><div class="spinner" /></div>}
        <p class="note-text center" id="ed-info" style={{ fontWeight: n ? 700 : 500, color: n ? 'var(--ink)' : undefined }}>{info}</p>
      </div>
      <div class="ed-bar ed-bar2">
        <div class="ed-rows">
          <div class="ed-row hscroll" role="toolbar" aria-label={t('edMove')}>
            <B icon="chevronL" label={t('edPrev')} onClick={() => stepSel(-1)} id="ed-prev" />
            <B icon="chevronR" label={t('edNext')} onClick={() => stepSel(1)} id="ed-next" />
            <span class="ed-sep" />
            <B icon="skipBack" label={t('edUndo')} onClick={undo} off={hist.i <= 0} id="ed-undo2" />
            <B icon="skipFwd" label={t('edRedo')} onClick={redo} off={hist.i >= hist.list.length - 1} id="ed-redo2" />
            <span class="ed-sep" />
            <B icon="speaker" label={t('edHear')} onClick={hear} id="ed-hear2" />
          </div>
          <div class="ed-row hscroll" role="toolbar" aria-label={t('edPitch')}>
            <B icon="arrowUp" label={t('edUp')} onClick={() => apply((sc, i) => movePitch(sc, i, 'up'))} off={!n || n.rest} id="ed-up" />
            <B icon="arrowDown" label={t('edDown')} onClick={() => apply((sc, i) => movePitch(sc, i, 'down'))} off={!n || n.rest} id="ed-down" />
            <B g="sharp" label={t('edSharpS')} onClick={() => apply((sc, i) => movePitch(sc, i, 'sharp'))} off={!n || n.rest} id="ed-sharp" />
            <B g="flat" label={t('edFlatS')} onClick={() => apply((sc, i) => movePitch(sc, i, 'flat'))} off={!n || n.rest} id="ed-flat" />
            <B g="natural" label={t('edNaturalS')} onClick={() => apply((sc, i) => naturalize(sc, i))} off={!n || n.rest || !n.pitch?.alter} id="ed-natural" />
            <B text="8↑" label={t('ed8va')} short={t('edOctUpS')} onClick={() => apply((sc, i) => movePitch(sc, i, 'octaveUp'))} off={!n || n.rest} />
            <B text="8↓" label={t('ed8vb')} short={t('edOctDnS')} onClick={() => apply((sc, i) => movePitch(sc, i, 'octaveDown'))} off={!n || n.rest} />
          </div>
          <div class="ed-row hscroll" role="toolbar" aria-label={t('edRhythm')}>
            {n?.rest
              ? <B icon="note1" label={t('edNote')} onClick={() => apply((sc, i) => toNote(sc, i))} id="ed-note" />
              : <B g="restQuarter" label={t('edRest')} onClick={() => apply((sc, i) => toRest(sc, i), false)} off={!n} id="ed-rest" />}
            <B text="÷2" label={t('edSplit')} onClick={() => apply(splitNote)} off={!n} id="ed-split" />
            <B text="+" label={t('edJoin')} short={t('edJoinS')} onClick={() => apply(joinNext)} off={!n} id="ed-join" />
            <B icon="chords" label={t('edChord')} short={t('edChordS')} onClick={() => apply(addChordNote)} off={!n || n.rest} id="ed-chord" />
            <B line="tie" label={t('lk_tie')} onClick={() => apply((sc, i) => toggleTie(sc, i))} off={!n || n.rest} id="ed-tie" />
            <B g="staccato" label={t('mk_staccato')} short={t('edStaccS')} on={n && hasMark(n, 'staccato')} onClick={() => apply((sc, i) => toggleMark(sc, i, 'staccato'))} off={!n || n.rest} id="ed-stacc" />
            <B g="accent" label={t('mk_accent')} on={n && hasMark(n, 'accent')} onClick={() => apply((sc, i) => toggleMark(sc, i, 'accent'))} off={!n || n.rest} id="ed-accent" />
          </div>
        </div>
      </div>
    </div>
  );
}
