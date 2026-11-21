// The studio's ribbon (Part 8): a menu of tabs across the top (Marks · Ornaments · Dynamics · Lines · Text ·
// Bars · and one for the instrument being written: Guitar, Ukulele, Bass, Strings, Piano, Drums, Voice, Winds,
// Brass, Chinese), and under it a long strip of tools for that tab, as in MuseScore 4, Dorico and Flat.
// Every symbol is drawn from the engraving font, so a button looks like the mark it puts on the page.
// Marks go on the chosen note (or the note just written); dynamics, text and lines go where the chosen note
// is (or at the cursor); bar tools work on the cursor's bar.
import { useState } from 'preact/hooks';
import { t } from '../../core/i18n.js';
import { toast } from '../state.js';
import { Icon } from '../components.jsx';
import { Glyph, LineIcon, ChordBox } from '../glyphs.jsx';
import { ZERO } from '../../core/q.js';
import { findNote } from '../../core/edit.js';
import { noteBefore, setChordSymbol, addBars } from '../../core/write.js';
import { parseChord, formatChord } from '../../core/chords.js';
import { diagramFor, chordChoices, fretsFor } from '../../core/fretboard.js';
import {
  hasMark, toggleMark, toggleLink, linkStarts, toggleTie, setFingering, fingeringOf, setStringNo, DYNAMICS_ALL, putDynamic, toggleText, TEMPO_MARKS, putTempo,
  putRehearsal, toggleJump, putSpan, clearPlace, setBarline, toggleEnding, insertBar, deleteBar, clearBar, copyBar, pasteBar, setTimeFrom, setClef,
  autoFingering, clearFingering, autoFingerable, setLyric, lyricOf, nextNote, KIT, GROOVES, fillGroove, toggleGhost, withFrame,
} from '../../core/notation.js';

/** Which instrument tab a part gets. */
export function instTab(instrument) {
  if (instrument === 'drums') return 'drums';
  if (fretsFor(instrument) === 'ukulele') return 'uke';
  if (fretsFor(instrument)) return 'guitar';
  if (instrument === 'bassguitar') return 'bass';
  if (['violin', 'viola', 'cello', 'doublebass', 'erhu'].includes(instrument)) return 'strings';
  if (['piano', 'keyboard', 'organ', 'harp', 'xylophone'].includes(instrument)) return 'piano';
  if (['voice', 'soprano', 'alto', 'tenor', 'bass'].includes(instrument)) return 'voice';
  if (['trumpet', 'horn', 'trombone', 'tuba'].includes(instrument)) return 'brass';
  if (['guzheng', 'pipa', 'dizi'].includes(instrument)) return 'chinese';
  return 'wind';
}
const TAB_LABEL = { guitar: 'rbGuitar', uke: 'rbUke', bass: 'rbBass', strings: 'rbStrings', piano: 'rbPiano', drums: 'rbDrums', voice: 'rbVoice', wind: 'rbWind', brass: 'rbBrass', chinese: 'rbChinese' };
const TAB_ICON = { guitar: 'guitar', uke: 'guitar', bass: 'guitar', strings: 'violin', piano: 'piano', drums: 'drum', voice: 'mic', wind: 'flute', brass: 'trumpet', chinese: 'note1' };

const MARK_GLYPH = { staccato: 'staccato', staccatissimo: 'staccatissimo', spiccato: 'spiccato', tenuto: 'tenuto', accent: 'accent', marcato: 'marcato', breath: 'breath', caesura: 'caesura',
  fermata: 'fermata', fermataBelow: 'fermataBelow', trill: 'trill', mordent: 'mordent', prall: 'prall', turn: 'turn', turnInv: 'turnInv', trem1: 'trem1', trem2: 'trem2', trem3: 'trem3',
  upBow: 'upBow', downBow: 'downBow', harmonic: 'harmonic', open: 'open', stopped: 'stopped', snapPizz: 'snapPizz' };

/** One tool: a symbol (glyph, line drawing, text) over a short name. */
function Tool({ g, line, txt, cls = '', label, on, onClick, id, wide }) {
  return (
    <button type="button" class={`rb-tool${on ? ' on' : ''}${wide ? ' wide' : ''} ${cls}`} onClick={onClick} id={id} title={label} aria-pressed={on === undefined ? undefined : !!on}>
      <span class="rb-ic">{g ? <Glyph name={g} size={26} /> : line ? <LineIcon kind={line} size={24} /> : <span class="rb-txt">{txt}</span>}</span>
      <span class="rb-lbl">{label}</span>
    </button>
  );
}
const Group = ({ title, children, cls = '' }) => <div class={`rb-group ${cls}`}><div class="rb-items">{children}</div>{title && <div class="rb-gt">{title}</div>}</div>;

export function Ribbon({ api }) {
  const { score, cur, sel, part, commit, setSel, setCur, keyF, instrument } = api;
  const itab = instTab(instrument);
  const [tab, setTab] = useState(itab);
  const [open, setOpen] = useState(true);
  const [bars, setBars] = useState(1);
  const [clip, setClip] = useState(null);
  const [word, setWord] = useState('');
  const [wordStyle, setWordStyle] = useState('expression');
  const [root, setRoot] = useState('C');
  const [lyric, setLyricText] = useState('');
  const pi = cur.pi || 0;
  const tabs = ['marks', 'orn', 'dyn', 'lines', 'text', 'bars'];

  // the note a mark goes on: the chosen one, else the one just written
  const target = () => {
    if (sel) return sel;
    const b = noteBefore(score, cur);
    return b && !b.note.rest ? b.note.id : null;
  };
  const tNote = () => { const id = target(); return id ? findNote(score, id)?.note : null; };
  const mark = (k) => { const id = target(); if (!id) { toast(t('tbNoteFirst')); return; } const out = toggleMark(score, id, k); if (out === score) toast(t('edCant'), 'err'); else commit(out); };
  const link = (k) => {
    const id = target(); if (!id) { toast(t('tbNoteFirst')); return; }
    const out = k === 'tie' ? toggleTie(score, id) : toggleLink(score, id, k);
    if (out === score) toast(t(k === 'tie' ? 'tbTieNo' : 'tbLinkNo'), 'err'); else commit(out);
  };
  // where dynamics, text and lines go
  const place = () => {
    if (sel) { const loc = findNote(score, sel); if (loc) return { pi: loc.pi, mi: loc.mi, off: loc.note.off, staff: loc.note.staff || 1 }; }
    return { pi, mi: cur.mi, off: cur.off.ge(score.measures[cur.mi]?.dur || ZERO) ? ZERO : cur.off, staff: cur.staff || 1 };
  };
  const dyn = (d) => { const p = place(); commit(putDynamic(score, p.pi, p.mi, p.off, p.staff, d)); };
  const span = (k) => { const p = place(); commit(putSpan(score, p.pi, p.mi, p.off, p.staff, k, bars)); };
  const text = (w, style) => { const p = place(); commit(toggleText(score, p.pi, p.mi, p.off, p.staff, w, style)); };
  const finger = (v, placement) => {
    const id = target(); if (!id) { toast(t('tbNoteFirst')); return; }
    const n = findNote(score, id)?.note;
    const now = fingeringOf(n);
    commit(setFingering(score, id, now === String(v) ? '' : v, placement || ((n?.staff || 1) === 2 ? 'below' : 'above')));
  };
  const isOn = (k) => { const n = tNote(); return n ? hasMark(n, k) : false; };
  const PORTATO = <span class="stack2"><Glyph name="tenuto" size={18} pad={30} /><Glyph name="staccato" size={14} pad={60} /></span>;
  const markTool = (k, extra = {}) => <Tool key={k} {...(MARK_GLYPH[k] ? { g: MARK_GLYPH[k] } : { txt: k === 'portato' ? PORTATO : k === 'thumb' ? 'thumb' : k })} label={t(`mk_${k}`)} on={isOn(k)} onClick={() => mark(k)} id={`rb-${k}`} {...extra} />;
  const linkTool = (k, line) => { const n = tNote(); return <Tool key={k} line={line} label={t(`lk_${k}`)} on={n ? (k === 'tie' ? !!n.tie?.start : linkStarts(n, k)) : false} onClick={() => link(k)} id={`rb-${k}`} />; };
  const spanTool = (k, view) => <Tool key={k} {...view} label={t(`sp_${k}`)} onClick={() => span(k)} id={`rb-sp-${k}`} />;
  const wordTool = (w, style = 'technique', cls = '') => <Tool key={w} txt={w} cls={`it word ${cls}`} label={w} onClick={() => text(w, style)} id={`rb-w-${w.replace(/[^a-z0-9]/gi, '') || encodeURIComponent(w).replace(/%/g, '')}`} wide={w.length > 5} />;
  const barCount = (
    <Group title={t('spanBars')}>
      {[1, 2, 4, 8].map((n) => <Tool key={n} txt={n} label={t('spanN', { n })} on={bars === n} onClick={() => setBars(n)} id={`rb-bars-${n}`} />)}
    </Group>
  );

  // ---- the tabs
  const panes = {
    marks: <>
      <Group title={t('rgArtic')}>{['staccato', 'staccatissimo', 'tenuto', 'portato', 'accent', 'marcato', 'spiccato'].map((k) => (k === 'portato'
        ? markTool('portato') : markTool(k)))}</Group>
      <Group title={t('rgPause')}>{['fermata', 'fermataBelow', 'breath', 'caesura'].map((k) => markTool(k))}</Group>
      <Group title={t('rgLink')}>{linkTool('slur', 'slur')}{linkTool('tie', 'tie')}</Group>
    </>,
    orn: <>
      <Group title={t('rgOrn')}>{['trill', 'mordent', 'prall', 'turn', 'turnInv'].map((k) => markTool(k))}</Group>
      <Group title={t('rgTrem')}>{['trem1', 'trem2', 'trem3'].map((k) => markTool(k))}</Group>
      <Group title={t('rgArp')}>
        <Tool line="arpeggio" label={t('mk_arpeggio')} on={isOn('arpeggio')} onClick={() => mark('arpeggio')} id="rb-arpeggio" />
        <Tool line="arpUp" label={t('mk_arpUp')} on={isOn('arpUp')} onClick={() => mark('arpUp')} id="rb-arpUp" />
        <Tool line="arpDown" label={t('mk_arpDown')} on={isOn('arpDown')} onClick={() => mark('arpDown')} id="rb-arpDown" />
        {linkTool('gliss', 'gliss')}
      </Group>
    </>,
    dyn: <>
      <Group title={t('rgDyn')}>{DYNAMICS_ALL.map((d) => <Tool key={d} txt={d} cls="dyn" label={d} onClick={() => dyn(d)} id={`rb-dyn-${d}`} />)}</Group>
      <Group title={t('rgHairpin')}>{spanTool('cresc', { line: 'cresc' })}{spanTool('dim', { line: 'dim' })}{wordTool('cresc.', 'expression')}{wordTool('dim.', 'expression')}{wordTool('subito', 'expression')}</Group>
      {barCount}
    </>,
    lines: <>
      <Group title={t('rgLink')}>{linkTool('slur', 'slur')}{linkTool('tie', 'tie')}{linkTool('gliss', 'gliss')}{linkTool('slide', 'slide')}</Group>
      <Group title={t('rgHairpin')}>{spanTool('cresc', { line: 'cresc' })}{spanTool('dim', { line: 'dim' })}</Group>
      <Group title={t('rgOttava')}>{spanTool('8va', { g: 'ottava' })}{spanTool('8vb', { txt: '8vb', cls: 'it' })}{spanTool('15ma', { g: 'quindicesima' })}</Group>
      <Group title={t('pnPedal')}>{spanTool('pedal', { line: 'pedal' })}{spanTool('ped', { g: 'ped' })}</Group>
      {barCount}
      <Group><Tool line="remove" label={t('clearHere')} onClick={() => { const p = place(); commit(clearPlace(score, p.pi, p.mi, p.off, p.staff)); }} id="rb-clear-here" /></Group>
    </>,
    text: <>
      <Group title={t('txTempo')}>{TEMPO_MARKS.map(([w, bpm]) => <Tool key={w} txt={w} cls="bold" label={`♩ = ${bpm}`} onClick={() => commit(putTempo(score, cur.mi, w, bpm))} id={`rb-tempo-${w}`} wide />)}
        {['rit.', 'rall.', 'accel.', 'a tempo'].map((w) => wordTool(w, 'technique'))}</Group>
      <Group title={t('txExpr')}>{['dolce', 'espress.', 'cantabile', 'legato', 'leggiero', 'marcato', 'sempre', 'poco a poco', 'molto', 'sostenuto'].map((w) => wordTool(w, 'expression'))}</Group>
      <Group title={t('txJumps')}>
        <Tool txt="A" cls="box" label={t('txRehearsal')} onClick={() => commit(putRehearsal(score, cur.mi))} id="rb-rehearsal" />
        <Tool g="segno" label="Segno" onClick={() => commit(toggleJump(score, cur.mi, 'segno'))} id="rb-segno" />
        <Tool g="coda" label="Coda" onClick={() => commit(toggleJump(score, cur.mi, 'coda'))} id="rb-coda" />
        {[['fine', 'Fine'], ['dc', 'D.C.'], ['dcFine', 'D.C. al Fine'], ['ds', 'D.S.'], ['dsCoda', 'D.S. al Coda'], ['toCoda', 'To Coda']].map(([k, w]) => <Tool key={k} txt={w} cls="it" label={w} onClick={() => commit(toggleJump(score, cur.mi, k))} id={`rb-jump-${k}`} wide={w.length > 5} />)}
      </Group>
      <Group title={t('txCustom')}>
        <form class="rb-form" onSubmit={(e) => { e.preventDefault(); if (word.trim()) { text(word.trim(), wordStyle); setWord(''); } }}>
          <input value={word} onInput={(e) => setWord(e.currentTarget.value)} placeholder={t('txCustomPh')} maxLength={40} id="rb-word" aria-label={t('txCustom')} />
          <select value={wordStyle} onChange={(e) => setWordStyle(e.currentTarget.value)} aria-label={t('txStyle')}><option value="expression">{t('txBelow')}</option><option value="technique">{t('txAbove')}</option><option value="tempo">{t('txBold')}</option></select>
          <button type="submit" class="rb-go" id="rb-word-add">{t('txAdd')}</button>
        </form>
      </Group>
    </>,
    bars: <>
      <Group title={t('brBarlines')}>
        {[['normal', 'bar'], ['double', 'double'], ['final', 'final'], ['repeatStart', 'repeatStart'], ['repeatEnd', 'repeatEnd']].map(([k, ic]) => <Tool key={k} line={ic} label={t(`br_${k}`)} onClick={() => commit(setBarline(score, cur.mi, k))} id={`rb-bl-${k}`} />)}
        <Tool txt="1." cls="ending" label={t('br_end1')} onClick={() => commit(toggleEnding(score, cur.mi, 1))} id="rb-end1" />
        <Tool txt="2." cls="ending" label={t('br_end2')} onClick={() => commit(toggleEnding(score, cur.mi, 2))} id="rb-end2" />
      </Group>
      <Group title={t('brEdit')}>
        <Tool line="insert" label={t('br_insBefore')} onClick={() => { commit(insertBar(score, cur.mi)); setSel(null); setCur((c) => ({ ...c, off: ZERO })); }} id="rb-ins-before" />
        <Tool line="insert" label={t('br_insAfter')} onClick={() => { commit(insertBar(score, cur.mi + 1)); setSel(null); setCur((c) => ({ ...c, mi: c.mi + 1, off: ZERO })); }} id="rb-ins-after" />
        <Tool line="remove" label={t('br_delete')} onClick={() => { if (score.measures.length <= 1) return; commit(deleteBar(score, cur.mi)); setSel(null); setCur((c) => ({ ...c, mi: Math.max(0, Math.min(c.mi, score.measures.length - 2)), off: ZERO })); }} id="rb-del-bar" />
        <Tool txt={<Icon name="close" size={18} />} label={t('br_clear')} onClick={() => { commit(clearBar(score, pi, cur.mi)); setSel(null); }} id="rb-clear-bar" />
        <Tool txt={<Icon name="copy" size={18} />} label={t('br_copy')} onClick={() => { setClip(copyBar(score, pi, cur.mi)); toast(t('brCopied', { n: cur.mi + 1 })); }} id="rb-copy-bar" />
        <Tool txt={<Icon name="doc" size={18} />} label={t('br_paste')} on={!!clip && undefined} onClick={() => { const out = pasteBar(score, pi, cur.mi, clip); if (!out) toast(t('brPasteNo'), 'err'); else { commit(out); setSel(null); } }} id="rb-paste-bar" />
        <Tool txt="+4" label={t('br_add4')} onClick={() => commit(addBars(score, 4))} id="rb-add4" />
      </Group>
      <Group title={t('brTime')}>
        {[[2, 4], [3, 4], [4, 4], [5, 4], [6, 8], [7, 8], [9, 8], [12, 8], [2, 2]].map(([b, bt]) => (
          <Tool key={`${b}/${bt}`} txt={<span class="tsig"><b>{b}</b><b>{bt}</b></span>} label={`${b}/${bt}`} onClick={() => { const out = setTimeFrom(score, cur.mi, [b, bt]); if (!out) toast(t('brTimeNo'), 'err'); else { commit(out); setCur((c) => ({ ...c, off: ZERO })); } }} id={`rb-time-${b}-${bt}`} />))}
      </Group>
      <Group title={t('brClef')}>
        {[['treble', 'gClef'], ['bass', 'fClef'], ['alto', 'cClef'], ['tenor', 'cClef'], ['treble8vb', 'gClef8vb'], ['percussion', 'percClef']].map(([k, g]) => (
          <Tool key={k} g={g} label={t(`cl_${k}`)} onClick={() => commit(setClef(score, pi, cur.mi, cur.staff || 1, k))} id={`rb-clef-${k}`} />))}
      </Group>
    </>,
    ...instPanes(),
  };

  function instPanes() {
    const fingers = (list, placement) => list.map((v) => <Tool key={v} txt={v} cls="fing" label={t('fingerN', { n: v })} on={fingeringOf(tNote()) === String(v)} onClick={() => finger(v, placement)} id={`rb-f-${v}`} />);
    const auto = autoFingerable(instrument) && (
      <Group title={t('stAuto')}>
        <Tool txt={<Icon name="sparkles" size={18} />} label={t('stAutoGo')} onClick={() => { const r = autoFingering(score, pi); if (!r.count) toast(t('edCant'), 'err'); else { commit(r.score); toast(t('stAutoDone', { n: r.count })); } }} id="rb-autofinger" wide />
        <Tool line="remove" label={t('stClear')} onClick={() => commit(clearFingering(score, pi))} id="rb-clearfinger" />
      </Group>
    );
    const set = fretsFor(instrument);
    const strNo = (n, k) => { const id = target(); if (!id) { toast(t('tbNoteFirst')); return; } commit(setStringNo(score, id, k)); const p = place(); commit(toggleText(setStringNo(score, id, k), p.pi, p.mi, p.off, p.staff, n, 'technique')); };
    const chordGrid = set && (() => {
      const put = (name) => {
        const c = parseChord(name);
        const d = diagramFor(c, set);
        const p = place();
        let out = setChordSymbol(score, p.mi, name, p.off);
        if (!out) { toast(t('chordNotUnderstood'), 'err'); return; }
        out = withFrame(out, p.mi, p.off, d);
        commit(out);
        if (!d) toast(t('gtNoBox', { inst: t(set === 'ukulele' ? 'rbUke' : 'rbGuitar') }));
      };
      const QUAL = ['', 'm', '7', 'm7', 'maj7', 'sus2', 'sus4', 'dim', 'aug', '6', '9', 'add9'];
      return <>
        <Group title={t('gtDiagrams')} cls="wrap2">
          {chordChoices(keyF, set).map((name) => <button type="button" key={name} class="rb-chord" onClick={() => put(name)} id={`rb-chord-${name}`} title={name}><ChordBox d={diagramFor(name, set)} name={name} size={58} /></button>)}
        </Group>
        <Group title={t('gtBuild')}>
          <div class="rb-build">
            <div class="rb-roots">{['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'].map((r) => <button type="button" key={r} class={root === r ? 'on' : ''} onClick={() => setRoot(r)}>{formatChord(parseChord(r))}</button>)}</div>
            <div class="rb-roots q">{QUAL.map((qq) => { const nm = root + qq; const ok = !!diagramFor(nm, set); return <button type="button" key={qq} disabled={!ok} onClick={() => put(nm)} id={`rb-q-${qq || 'maj'}`}>{formatChord(parseChord(nm))}</button>; })}</div>
          </div>
        </Group>
      </>;
    })();
    return {
      guitar: <>
        {chordGrid}
        <Group title={t('gtTech')}>
          {linkTool('hammer', 'slur')}{linkTool('pull', 'slur')}{linkTool('slide', 'slide')}
          {wordTool('½', 'technique')}{wordTool('full', 'technique')}{wordTool('vib.', 'technique')}
          {spanTool('pm', { txt: 'P.M.' })}{spanTool('letRing', { txt: 'let ring', cls: 'it' })}{markTool('harmonic')}
          <Tool line="arpUp" label={t('mk_arpUp')} on={isOn('arpUp')} onClick={() => mark('arpUp')} id="rb-g-arpUp" />
          <Tool line="arpDown" label={t('mk_arpDown')} on={isOn('arpDown')} onClick={() => mark('arpDown')} id="rb-g-arpDown" />
        </Group>
        <Group title={t('gtPluck')}>{fingers(['p', 'i', 'm', 'a'], 'below')}</Group>
        <Group title={t('gtFinger')}>{fingers([1, 2, 3, 4], 'above')}</Group>
        <Group title={t('gtString')}>{['①', '②', '③', '④', '⑤', '⑥'].map((c, i) => <Tool key={c} txt={c} label={t('stringN', { n: i + 1 })} onClick={() => strNo(c, i + 1)} id={`rb-str-${i + 1}`} />)}</Group>
      </>,
      uke: <>
        {chordGrid}
        <Group title={t('gtTech')}>{linkTool('hammer', 'slur')}{linkTool('pull', 'slur')}{linkTool('slide', 'slide')}{markTool('trem3')}
          <Tool line="arpUp" label={t('mk_arpUp')} on={isOn('arpUp')} onClick={() => mark('arpUp')} id="rb-u-arpUp" />
          <Tool line="arpDown" label={t('mk_arpDown')} on={isOn('arpDown')} onClick={() => mark('arpDown')} id="rb-u-arpDown" /></Group>
        <Group title={t('gtFinger')}>{fingers([1, 2, 3, 4], 'above')}</Group>
      </>,
      bass: <>
        <Group title={t('gtTech')}>{linkTool('hammer', 'slur')}{linkTool('pull', 'slur')}{linkTool('slide', 'slide')}{linkTool('gliss', 'gliss')}{wordTool('S', 'technique', 'bold')}{wordTool('P', 'technique', 'bold')}{markTool('harmonic')}{spanTool('pm', { txt: 'P.M.' })}</Group>
        <Group title={t('gtFinger')}>{fingers([1, 2, 3, 4], 'above')}</Group>
        <Group title={t('gtString')}>{['Ⅳ', 'Ⅲ', 'Ⅱ', 'Ⅰ'].map((c, i) => <Tool key={c} txt={c} label={t('stringN', { n: 4 - i })} onClick={() => strNo(c, 4 - i)} id={`rb-bstr-${4 - i}`} />)}</Group>
      </>,
      strings: <>
        <Group title={t('stBowing')}>{markTool('downBow')}{markTool('upBow')}{linkTool('slur', 'slur')}{markTool('portato')}{markTool('spiccato')}</Group>
        <Group title={t('stFingers')}>{fingers([0, 1, 2, 3, 4], 'above')}</Group>
        {auto}
        <Group title={t('stString')}>{(instrument === 'erhu' ? ['内弦', '外弦'] : instrument === 'cello' || instrument === 'viola' ? ['sul A', 'sul D', 'sul G', 'sul C'] : instrument === 'doublebass' ? ['sul G', 'sul D', 'sul A', 'sul E'] : ['sul E', 'sul A', 'sul D', 'sul G']).map((w) => wordTool(w, 'technique'))}</Group>
        <Group title={t('stPlay')}>
          {['pizz.', 'arco', 'col legno', 'sul pont.', 'sul tasto', 'con sord.', 'senza sord.', 'div.', 'unis.'].map((w) => wordTool(w, 'technique'))}
          {markTool('harmonic')}{markTool('open')}{markTool('snapPizz')}{markTool('stopped')}{instrument === 'cello' && <Tool txt="thumb" cls="it" label={t('mk_thumb')} on={isOn('thumb')} onClick={() => mark('thumb')} id="rb-thumb" />}{markTool('trem3')}{linkTool('gliss', 'gliss')}
          {instrument === 'erhu' && ['滑音', '揉弦', '颤音', '拨弦', '泛音'].map((w) => wordTool(w, 'technique'))}
        </Group>
      </>,
      piano: <>
        <Group title={t('pnHands')}>
          {(part?.staves || 1) > 1 && <>
            <Tool txt="R.H." cls="bold" label={t('tbRH')} on={(cur.staff || 1) === 1} onClick={() => { setSel(null); setCur((c) => ({ ...c, staff: 1 })); }} id="rb-rh" />
            <Tool txt="L.H." cls="bold" label={t('tbLH')} on={(cur.staff || 1) === 2} onClick={() => { setSel(null); setCur((c) => ({ ...c, staff: 2 })); }} id="rb-lh" />
          </>}
          {wordTool('m.d.', 'technique')}{wordTool('m.s.', 'technique')}
        </Group>
        <Group title={t('pnFingers')}>{fingers([1, 2, 3, 4, 5])}</Group>
        {auto}
        <Group title={t('pnPedal')}>{spanTool('ped', { g: 'ped' })}{spanTool('pedal', { line: 'pedal' })}{wordTool('una corda', 'technique')}{wordTool('tre corde', 'technique')}</Group>
        <Group title={t('rgOttava')}>{spanTool('8va', { g: 'ottava' })}{spanTool('8vb', { txt: '8vb', cls: 'it' })}{spanTool('15ma', { g: 'quindicesima' })}</Group>
        <Group title={t('rgArp')}><Tool line="arpeggio" label={t('mk_arpeggio')} on={isOn('arpeggio')} onClick={() => mark('arpeggio')} id="rb-p-arpeggio" />{markTool('trill')}{markTool('trem3')}</Group>
        {barCount}
      </>,
      drums: <>
        <Group title={t('drGrooves')}>{Object.keys(GROOVES).map((g) => <Tool key={g} txt={<Icon name="drum" size={18} />} label={t(`gr_${g}`)} onClick={() => { commit(fillGroove(score, pi, cur.mi, g)); setSel(null); setCur((c) => ({ ...c, mi: Math.min(c.mi + 1, score.measures.length), off: ZERO })); }} id={`rb-groove-${g}`} wide />)}</Group>
        <Group title={t('drTech')}>
          <Tool txt="( )" label={t('drGhost')} onClick={() => { const id = target(); if (id) commit(toggleGhost(score, id)); else toast(t('tbNoteFirst')); }} id="rb-ghost" />
          {markTool('accent')}{markTool('trem3', { label: t('drRoll') })}{markTool('trem1', { label: t('drDiddle') })}{wordTool('R', 'technique', 'bold')}{wordTool('L', 'technique', 'bold')}{wordTool('choke', 'technique')}{wordTool('rimshot', 'technique')}
        </Group>
        {barCount}
      </>,
      voice: <>
        <Group title={t('vcLyrics')}>
          <form class="rb-form" onSubmit={(e) => {
            e.preventDefault();
            const id = target(); if (!id) { toast(t('tbNoteFirst')); return; }
            commit(setLyric(score, id, lyric));
            const nx = nextNote(setLyric(score, id, lyric), id);
            setLyricText(nx ? lyricOf(nx.note) : '');
            if (nx) { setSel(nx.note.id); setCur((c) => ({ ...c, mi: nx.mi, off: nx.note.off })); }
          }}>
            <input value={lyric} onInput={(e) => setLyricText(e.currentTarget.value)} placeholder={t('vcLyricPh')} maxLength={30} id="rb-lyric" aria-label={t('vcLyrics')} onFocus={() => { const n = tNote(); if (n && !lyric) setLyricText(lyricOf(n)); }} />
            <button type="submit" class="rb-go" id="rb-lyric-next">{t('vcNext')}</button>
          </form>
          <p class="rb-help">{t('vcLyricsSub')}</p>
        </Group>
        <Group title={t('rgPause')}>{markTool('breath')}{markTool('caesura')}{markTool('fermata')}{linkTool('slur', 'slur')}</Group>
        <Group title={t('txExpr')}>{['a cappella', 'hum', 'falsetto', 'spoken', 'rit.', 'a tempo'].map((w) => wordTool(w, w.startsWith('a') || w === 'rit.' ? 'technique' : 'expression'))}</Group>
      </>,
      wind: <>
        <Group title={t('wdBreath')}>{markTool('breath')}{linkTool('slur', 'slur')}{markTool('tenuto')}{markTool('staccato')}{markTool('accent')}</Group>
        <Group title={t('wdTongue')}><Tool txt="TK" cls="bold" label={t('mk_doubleTongue')} on={isOn('doubleTongue')} onClick={() => mark('doubleTongue')} id="rb-dt" /><Tool txt="TKT" cls="bold" label={t('mk_tripleTongue')} on={isOn('tripleTongue')} onClick={() => mark('tripleTongue')} id="rb-tt" />{markTool('trem3', { label: 'flz.' })}{wordTool('flz.', 'technique')}</Group>
        <Group title={t('rgOrn')}>{markTool('trill')}{markTool('mordent')}{markTool('turn')}{linkTool('gliss', 'gliss')}{markTool('harmonic')}</Group>
      </>,
      brass: <>
        <Group title={t('wdBreath')}>{markTool('breath')}{linkTool('slur', 'slur')}{markTool('accent')}{markTool('marcato')}</Group>
        <Group title={t('wdMute')}>{['con sord.', 'senza sord.', 'straight mute', 'cup mute', 'harmon'].map((w) => wordTool(w, 'technique'))}{markTool('stopped')}{markTool('open')}</Group>
        <Group title={t('wdTongue')}><Tool txt="TK" cls="bold" label={t('mk_doubleTongue')} on={isOn('doubleTongue')} onClick={() => mark('doubleTongue')} id="rb-b-dt" />{markTool('trem3', { label: 'flz.' })}{linkTool('gliss', 'gliss')}{wordTool('shake', 'technique')}{wordTool('fall', 'technique')}{wordTool('doit', 'technique')}</Group>
      </>,
      chinese: <>
        <Group title={t('cnTech')}>{(instrument === 'dizi' ? ['花舌', '叠音', '打音', '颤音', '滑音', '历音'] : instrument === 'pipa' ? ['轮指', '扫', '弹', '挑', '推', '拉', '泛音'] : ['摇指', '刮奏', '按音', '滑音', '泛音', '揉弦', '轮指']).map((w) => wordTool(w, 'technique', 'zh'))}</Group>
        <Group title={t('gtTech')}>{markTool('trem3')}{linkTool('gliss', 'gliss')}{markTool('harmonic')}<Tool line="arpUp" label={t('mk_arpUp')} on={isOn('arpUp')} onClick={() => mark('arpUp')} id="rb-c-arpUp" />{markTool('breath')}</Group>
        <Group title={t('gtFinger')}>{fingers([1, 2, 3, 4, 5])}</Group>
      </>,
    };
  }

  return (
    <div class={`rb${open ? '' : ' shut'}`} id="st-ribbon">
      <div class="rb-tabs hscroll" role="tablist" aria-label={t('rbMenu')}>
        <button type="button" role="tab" aria-selected={tab === itab} class={`rb-tab inst${tab === itab ? ' on' : ''}`} onClick={() => { if (tab === itab) setOpen(!open); else { setTab(itab); setOpen(true); } }} id={`rbt-${itab}`}>
          <Icon name={TAB_ICON[itab]} size={15} />{t(TAB_LABEL[itab])}
        </button>
        {tabs.map((k) => (
          <button type="button" role="tab" key={k} aria-selected={tab === k} class={`rb-tab${tab === k ? ' on' : ''}`} onClick={() => { if (tab === k) setOpen(!open); else { setTab(k); setOpen(true); } }} id={`rbt-${k}`}>
            {t(`rb_${k}`)}
          </button>
        ))}
        <button type="button" class="rb-fold" onClick={() => setOpen(!open)} aria-label={t(open ? 'rbHide' : 'rbShow')} id="rb-fold"><Icon name={open ? 'chevronU' : 'chevronD'} size={16} /></button>
      </div>
      {open && <div class="rb-pane hscroll" role="tabpanel" id={`rbp-${tab}`}>{panes[tab]}</div>}
    </div>
  );
}

/** Chord boxes for the chord symbols in the bars on screen (guitar and ukulele parts). */
export function DiagramLane({ score, from, count, set, cur, onBar }) {
  const items = [];
  for (let mi = from; mi < Math.min(score.measures.length, from + count); mi++) {
    for (const h of score.parts[0]?.measures[mi]?.harmonies || []) {
      if (!h.chord || h.chord.nc) continue;
      const name = h.text || formatChord(h.chord);
      items.push({ mi, off: h.off, name, d: h.frame || diagramFor(h.chord, set) });
    }
  }
  if (!items.length) return <p class="note-text center diag-empty" id="diag-lane">{t('gtLaneEmpty')}</p>;
  return (
    <div class="diag-lane" id="diag-lane">
      {items.map((x, i) => (
        <button type="button" key={i} class={`diag${cur.mi === x.mi ? ' on' : ''}`} onClick={() => onBar(x.mi, x.off)}>
          <span class="dg-bar">{t('bar', { n: x.mi + 1 })}</span>
          {x.d ? <ChordBox d={x.d} name={x.name} size={70} /> : <strong>{x.name}</strong>}
        </button>
      ))}
    </div>
  );
}
