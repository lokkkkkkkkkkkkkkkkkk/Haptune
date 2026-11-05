// "Vary a song": the AI decorates a song's own melody but never moves its main notes, so it still sounds
// like the song. Pick a song, say how much to change, hear the original and the variation side by side.
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { useApp, getPiece, addScore, toast, push, go, openSheet, logMinutes, awardBadge, addXP } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, Card, Section, List, Row, Button, Chip } from '../components.jsx';
import { Mascot } from '../mascot.jsx';
import { renderMusicXML } from '../verovio.js';
import { Transport, audioContext } from '../audio.js';
import { SOUND } from './piece.jsx';
import { writeMusicXML } from '../../core/musicxml.js';
import { varyMelody } from '../../core/variation.js';
import { transposeScore, performance as perfOf, secondsAt, quartersAt, partChoices } from '../../core/score.js';
import { STYLES } from '../../core/improv.js';

export const STYLE_META = [
  ['pop', 'pink', 'library'], ['ballad', 'blue', 'moon'], ['pentatonic', 'teal', 'globe'], ['blues', 'indigo', 'guitar'],
  ['jazz', 'orange', 'sparkles'], ['bossa', 'green', 'drone'], ['baroque', 'brown', 'staff'], ['rock', 'red', 'bolt'],
];
const AMOUNTS = [['light', 'lightTouch', 'lightTouchHelp', 'pencil'], ['balanced', 'balanced', 'balancedHelp', 'wand'], ['free', 'freeStyle', 'freeHelp', 'bolt']];
const ROW_COLORS = ['pink', 'blue', 'green', 'orange', 'purple', 'teal'];

/** Swing: offbeat eighths move later (ratio 2:1 = 0.667 of the beat). */
export function swingQ(x, ratio) {
  if (!ratio) return x;
  const b = Math.floor(x + 1e-9), f = x - b;
  return b + (f < 0.5 ? f * (ratio / 0.5) : ratio + (f - 0.5) * ((1 - ratio) / 0.5));
}

/** Playback events for a score; the part being varied is a little louder so you can hear it. */
function eventsFor(score, sel, swing) {
  const perf = perfOf(score, { repeats: true });
  const sec = (x) => secondsAt(perf.tempos, x);
  const evs = [];
  for (const e of perf.events) {
    if (e.unpitched) continue;
    const lead = e.pi === sel.pi && (!sel.staff || (e.staff || 1) === sel.staff);
    const a = swingQ(e.t.num(), swing), b = swingQ(e.t.add(e.dur).num(), swing);
    evs.push({
      time: sec(a), dur: Math.max(0.06, (sec(b) - sec(a)) * 0.96), midi: e.midi,
      vel: lead ? Math.min(112, (e.vel || 80) + 12) : Math.round((e.vel || 80) * 0.7),
      inst: SOUND[score.parts[e.pi]?.instrument] || 'piano', ids: e.ids, pan: lead ? 0.1 : -0.25,
    });
  }
  evs.sort((x, y) => x.time - y.time);
  return { evs, length: sec(perf.length) + 0.4, tempos: perf.tempos };
}

export function VaryPanel({ active, src }) {
  const s = useApp();
  const [song, setSong] = useState(null);        // {id, title, score, semis}
  const [choice, setChoice] = useState(null);
  const [amount, setAmount] = useState('light');
  const [style, setStyle] = useState('pop');
  const [seed, setSeed] = useState(1);
  const [svg, setSvg] = useState({ loading: false, pages: [] });
  const [playing, setPlaying] = useState(null);  // 'orig' | 'var'
  const [saved, setSaved] = useState(null);
  const [picking, setPicking] = useState(false);
  const tr = useRef(null);
  const built = useRef(null);
  const started = useRef(0);
  const boxRef = useRef(null);
  const lit = useRef({ key: '', els: [] });

  const songs = useMemo(() => s.pieces.filter((p) => p.kind === 'score')
    .sort((a, b) => (b.opened || b.created || 0) - (a.opened || a.created || 0)), [s.pieces]);

  const pick = async (id, semis = 0) => {
    stop();
    const d = await getPiece(id);
    if (!d?.score) return;
    setSong({ id, title: d.rec.title, sub: d.rec.composer || d.rec.keyText || '', score: semis ? transposeScore(d.score, semis) : d.score, semis });
    setChoice(null); setSeed(1); setSaved(null); setPicking(false);
  };
  // a song sent from its own screen ("Vary a song")
  useEffect(() => { if (src) pick(src.pieceId, src.semis || 0); }, [src?.n]);

  const choices = useMemo(() => (song ? partChoices(song.score) : []), [song]);
  const sel = choices.find((c) => c.id === choice) || choices[0] || { pi: 0, staff: 1 };
  const v = useMemo(() => (song ? varyMelody(song.score, { amount, style, seed, part: sel.pi, staff: sel.staff || 1 }) : null),
    [song, amount, style, seed, sel.pi, sel.staff]);
  const xml = useMemo(() => (v ? writeMusicXML({ ...v.score, title: `${song.title} – ${t('variation')}` }) : null), [v]);

  useEffect(() => {
    if (!xml) return;
    let alive = true;
    setSvg((x) => ({ ...x, loading: true }));
    const width = Math.min(900, (boxRef.current?.clientWidth || innerWidth - 40));
    renderMusicXML(xml, { width, scale: width < 500 ? 34 : 40 })
      .then((r) => alive && setSvg({ loading: false, pages: r.pages }))
      .catch(() => alive && setSvg({ loading: false, pages: [], failed: true }));
    return () => { alive = false; };
  }, [xml]);
  // new notes in purple
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !v) return;
    for (const id of v.changedIds) box.querySelector(`[id="${id}"]`)?.classList.add('changed');
  }, [svg.pages, v]);

  // ----- listening -----
  const clearLit = () => { lit.current.els.forEach((el) => el.classList.remove('now')); lit.current = { key: '', els: [] }; };
  const logPlayed = () => { if (started.current) logMinutes((performance.now() - started.current) / 1000); started.current = 0; };
  function stop() {
    if (tr.current?.playing) tr.current.stop();
    logPlayed();
    setPlaying(null);
    clearLit();
  }
  useEffect(() => { if (!active) stop(); }, [active]);
  useEffect(() => () => stop(), []);

  const light = (evs, sec) => {
    const box = boxRef.current;
    if (!box) return;
    let lo = 0, hi = evs.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (evs[mid].time <= sec) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    const ids = [];
    for (let i = idx; i >= 0 && i > idx - 48; i--) if (evs[i].time + evs[i].dur >= sec) ids.push(...(evs[i].ids || []));
    const key = ids.join(',');
    if (key === lit.current.key) return;
    lit.current.els.forEach((el) => el.classList.remove('now'));
    const els = ids.map((id) => box.querySelector(`[id="${id}"]`)).filter(Boolean);
    els.forEach((el) => el.classList.add('now'));
    lit.current = { key, els };
    const r = els[0]?.getBoundingClientRect();
    if (r && (r.top < 90 || r.bottom > innerHeight - 150)) els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const play = (which, from = 0) => {
    if (!v) return;
    audioContext();
    const b = eventsFor(which === 'orig' ? song.score : v.score, sel, which === 'var' ? (STYLES[style]?.swing || 0) : 0);
    built.current = b;
    if (!tr.current) tr.current = new Transport();
    const x = tr.current;
    if (x.playing) x.stop();
    x.load(b.evs, b.length);
    x.setLoop(null);
    x.onTime = (sec) => light(b.evs, sec);
    x.onEnd = () => { logPlayed(); setPlaying(null); clearLit(); };
    if (!started.current) started.current = performance.now();
    clearLit();
    x.play(from);
    setPlaying(which);
  };
  /** Tap Original or Variation; while one plays, the other carries on from the same beat. */
  const tap = (which) => {
    if (playing === which) { stop(); return; }
    let from = 0;
    if (playing && tr.current?.playing && built.current) {
      const tempos = built.current.tempos;
      from = secondsAt(tempos, Math.floor(quartersAt(tempos, tr.current.position())));
    }
    play(which, from);
  };
  // changing the recipe while the variation plays: keep playing the new one from the same beat
  useEffect(() => {
    if (playing !== 'var' || !tr.current?.playing || !built.current) return;
    const tempos = built.current.tempos;
    play('var', secondsAt(tempos, Math.floor(quartersAt(tempos, tr.current.position()))));
  }, [v]);

  const save = async () => {
    if (!v) return;
    const title = `${song.title} – ${t('variation')}`;
    const rec = await addScore({ ...v.score, title }, { source: 'improv', fmt: 'generated', title, extra: { changedIds: [...v.changedIds], variedFrom: song.id } });
    addXP(15);
    awardBadge('improviser');
    toast(t('savedToLibrary'));
    setSaved(rec.id);
  };

  if (!songs.length) {
    return (
      <Card class="vary-empty">
        <Mascot mood="think" size={96} />
        <p>{t('varyEmpty')}</p>
        <Button kind="brand" icon="plus" onClick={() => { go('library'); openSheet('add'); }}>{t('addMusic')}</Button>
      </Card>
    );
  }

  if (!song || picking) {
    return (
      <Section title={t('pickSong')}>
        <List>
          {songs.slice(0, 14).map((p, i) => (
            <Row key={p.id} icon="library" color={ROW_COLORS[i % ROW_COLORS.length]} title={p.title} subtitle={p.composer || p.keyText} chevron onClick={() => pick(p.id)} />
          ))}
        </List>
      </Section>
    );
  }

  const pct = Math.round((v?.similarity ?? 1) * 100);
  const label = (c) => (c.hand === 'right' ? t('rightHand') : c.hand === 'left' ? t('leftHand') : c.name);
  const help = AMOUNTS.find((a) => a[0] === amount)[2];
  return (
    <>
      <List>
        <Row icon="library" color="purple" title={song.title} subtitle={song.sub} right={<button type="button" class="link-btn" onClick={() => { stop(); setPicking(true); }}>{t('changeSong')}</button>} />
      </List>
      {choices.length > 1 && (
        <div class="chips wrap" role="radiogroup" aria-label={t('part')}>
          {choices.map((c) => <Chip key={c.id} on={sel.id === c.id} color="purple" onClick={() => setChoice(c.id)}>{label(c)}</Chip>)}
        </div>
      )}

      <Section title={t('howMuch')} footer={t(help)}>
        <div class="mode-cards three" role="radiogroup" aria-label={t('howMuch')}>
          {AMOUNTS.map(([id, name, , ic]) => (
            <button type="button" key={id} role="radio" aria-checked={amount === id} class={`mode-card${amount === id ? ' on' : ''}`} onClick={() => { setAmount(id); setSaved(null); }}>
              <Icon name={ic} size={22} stroke={2.2} /><strong>{t(name)}</strong>
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('style')}>
        <div class="chips style-chips">
          {STYLE_META.map(([id, color]) => (
            <Chip key={id} on={style === id} color={color} onClick={() => { setStyle(id); setSaved(null); }}><i class={`dot c-${color}`} />{t('st_' + id)}</Chip>
          ))}
        </div>
      </Section>

      {v && (
        <Card class="vary-result">
          <div class="sim">
            <Mascot mood={pct >= 80 ? 'cheer' : pct >= 60 ? 'wave' : 'think'} size={58} />
            <div class="sim-main">
              <strong>{t('soundsLike', { p: pct })}</strong>
              <div class="sim-bar" style={{ '--p': `${pct}%` }} role="meter" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100" aria-label={t('soundsLike', { p: pct })}><i /></div>
              <span class="sim-sub"><i class="legend-dot" />{t(v.changed === 1 ? 'changedNote' : 'changedNotes', { n: v.changed })}</span>
            </div>
          </div>
          <div class="ab-row">
            <button type="button" class={`ab${playing === 'orig' ? ' on' : ''}`} onClick={() => tap('orig')} aria-pressed={playing === 'orig'}>
              <Icon name={playing === 'orig' ? 'pause' : 'play'} size={20} stroke={2.4} />{t('originalSong')}
            </button>
            <button type="button" class={`ab var${playing === 'var' ? ' on' : ''}`} onClick={() => tap('var')} aria-pressed={playing === 'var'}>
              <Icon name={playing === 'var' ? 'pause' : 'play'} size={20} stroke={2.4} />{t('variation')}
            </button>
          </div>
          <p class="note-text" style={{ textAlign: 'center', margin: 0 }}>{t('abHint')}</p>
          <div class="vary-actions">
            <Button kind="secondary" color="purple" icon="sparkles" onClick={() => { setSeed(seed + 1); setSaved(null); }}>{t('tryAnother')}</Button>
            {saved
              ? <Button kind="secondary" color="green" icon="check" onClick={() => push('piece', { id: saved }, 'library')}>{t('openIt')}</Button>
              : <Button kind="brand" icon="plus" onClick={save}>{t('saveVersion')}</Button>}
          </div>
        </Card>
      )}

      {svg.failed ? <Card><p class="note-text">{t('engineFailedShort')}</p></Card> : null}
      {svg.loading && !svg.pages.length && <div class="loading"><Mascot mood="think" size={70} /></div>}
      <div class="score-box vrv vary-score" ref={boxRef} dangerouslySetInnerHTML={{ __html: svg.pages.join('') }} />
    </>
  );
}
