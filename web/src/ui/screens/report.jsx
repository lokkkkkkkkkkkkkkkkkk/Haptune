// The practice report after Play Along: overview first (score ring, stars, steadiness, intonation, rhythm), then
// every bar and every note that went wrong, the trend over earlier takes, three recommendations and a next
// exercise, the recording, and what to do with it: export, share, post to Stage, send to the teacher, or turn
// the take into a Sound. A teacher sees the same report in a student's timeline.
import { useMemo } from 'preact/hooks';
import { useApp, pop, push, openSheet, toast } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, Button, Section, List, Row, MiniLine } from '../components.jsx';
import { NavBar } from './common.jsx';
import { buildReport, reportText } from '../../core/report.js';
import { saveFile } from '../files.js';

export function ReportView({ result, pieceId, title = '', keySig = null, onPractise, onShowBar, onSend, onClass, onShare, assignment }) {
  const s = useApp();
  const r = useMemo(() => buildReport(result, { history: s.history, pieceId, key: keySig }), [result]);
  const o = r.overview;
  const back = (fn) => () => { pop(); setTimeout(() => fn?.(), 0); };
  const text = () => reportText(r, title, t);
  const share = async () => {
    try { if (navigator.share) { await navigator.share({ title, text: text() }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text()); toast(t('copied')); } catch { toast(text()); }
  };
  const png = async () => {
    try { await saveFile(`${title || 'report'} report.png`, await reportPng(r, title)); } catch (e) { toast(e.message || String(e), 'err'); }
  };
  const metric = (k, v) => v !== null && v !== undefined && <div class="rep-metric"><strong class="num">{v}%</strong><span>{t(k)}</span></div>;
  return (
    <div class="scroll" id="report">
      <NavBar title={t('reportT')} color="violet" backLabel={t('back')} />
      <div class="wrap" style={{ paddingTop: 12 }}>
        <div class="rep-head">
          <div class={`r3-ring ${o.accuracy >= 85 ? 'good' : o.accuracy >= 60 ? 'mid' : 'low'}`} style={{ '--p': o.accuracy }}><span class="num">{o.accuracy}<small>%</small></span></div>
          <div><h2 style={{ margin: 0 }}>{title}</h2><div class="r3-stars">{[0, 1, 2].map((i) => <Icon key={i} name="star" size={20} fill={i < o.stars} stroke={2} />)}</div>
            <span class="muted">{t('rightNotes')}: {o.right}/{o.total}</span></div>
        </div>
        <div class="rep-metrics">{metric('repStability', o.stability)}{metric('repIntonation', o.intonation)}{metric('repRhythm', o.rhythm)}{metric('repSpeed', o.speed)}</div>

        <Section title={t('repRecs')}>
          <List>{r.recommendations.map((x, i) => <Row key={x.key} icon={['loop', 'key', 'metronome'][i] || 'sparkles'} color={['orange', 'violet', 'teal'][i] || 'blue'} title={t(x.key, x.vars)}
            onClick={x.bars ? back(() => onPractise?.(x.bars[0], x.vars.speed)) : undefined} />)}
            <Row icon="stairs" color="green" title={t('repNext', { ...r.next, octaves: r.next.octaves })} onClick={() => openSheet('scale')} id="rep-next" />
          </List>
        </Section>

        {r.trend.length > 1 && (
          <Section title={t('repTrend')}>
            <div class="card rep-trend"><MiniLine values={r.trend.map((x) => Math.round(x.accuracy * 100))} width={320} height={70} min={0} max={100} color="violet" /></div>
          </Section>
        )}

        {r.bars.length > 0 && (
          <Section title={t('repBars')}>
            <div class="rep-bars" id="rep-bars">
              {r.bars.map((b) => (
                <div class={`rep-bar ${b.accuracy >= 0.85 ? 'ok' : b.accuracy >= 0.6 ? 'mid' : 'low'}`} key={b.bar}>
                  <span class="n">{t('bar', { n: b.bar })}</span><span class="track"><i style={{ width: `${b.pct}%` }} /></span><b>{b.pct}%</b>
                  {b.accuracy < 0.85 && <button type="button" class="link-btn" onClick={back(() => onPractise?.(b.bar - 1, Math.max(40, o.speed - 20)))}>{t('repLoop')}</button>}
                </div>
              ))}
            </div>
            {r.worstBars.length > 0 && <Button small kind="secondary" icon="play" onClick={back(() => onPractise?.(r.worstBars[0].bar - 1, Math.max(40, o.speed - 30)))}>{t('repReplaySlow')}</Button>}
          </Section>
        )}

        {r.notes.length > 0 && (
          <Section title={t('repNotes')}>
            <List>{r.notes.slice(0, 40).map((w, i) => <Row key={i} icon={w.played ? 'close' : 'minus'} color={w.played ? 'red' : 'gray'} title={`${t('bar', { n: w.bar })}: ${w.played ? `${w.played} → ${w.want}` : `${t('reportMissed')} ${w.want}`}`}
              onClick={back(() => onShowBar?.(w.mi))} />)}</List>
            <Button small kind="plain" icon="staff" onClick={back(() => onShowBar?.(r.notes[0].mi))}>{t('repShowOnScore')}</Button>
          </Section>
        )}

        {result.recordingURL && <Section title={t('yourTake')}><audio controls preload="metadata" src={result.recordingURL} style={{ width: '100%' }} /></Section>}

        <div class="rep-actions">
          <Button kind="secondary" icon="download" onClick={png} id="rep-png">{t('repExportPng')}</Button>
          <Button kind="secondary" icon="share" onClick={share} id="rep-share">{t('repShare')}</Button>
          {onShare && <Button kind="secondary" icon="stage" onClick={back(onShare)}>{t('shareWin')}</Button>}
          {assignment ? <Button kind="brand" icon="send" onClick={back(onSend)} disabled={result.sent}>{t('submitToTeacher')}</Button>
            : onClass && <Button kind="secondary" icon="academy" onClick={back(onClass)}>{t('shareWithClass')}</Button>}
          {result.recordingURL && <Button kind="secondary" icon="wave" onClick={() => push('sound', { fromTake: { url: result.recordingURL, title } })} id="rep-sound">{t('repToSound')}</Button>}
        </div>
      </div>
    </div>
  );
}

/** The report's overview as a PNG (for sharing on chat apps). */
export async function reportPng(r, title) {
  const W = 1080, H = 1350;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, W, H); grad.addColorStop(0, '#5B5BF6'); grad.addColorStop(1, '#F65C9B');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff'; g.font = '800 64px sans-serif'; g.fillText(title.slice(0, 26), 80, 160);
  g.font = '900 220px sans-serif'; g.fillText(`${r.overview.accuracy}%`, 80, 420);
  g.font = '700 54px sans-serif'; g.fillText('★'.repeat(r.overview.stars) + '☆'.repeat(3 - r.overview.stars), 80, 510);
  g.font = '500 40px sans-serif';
  let y = 620;
  for (const b of r.bars.slice(0, 16)) {
    g.globalAlpha = 0.3; g.fillRect(80 + ((b.bar - 1) % 8) * 115, y + Math.floor((b.bar - 1) / 8) * 90, 100, 70); g.globalAlpha = 1;
    g.fillRect(80 + ((b.bar - 1) % 8) * 115, y + Math.floor((b.bar - 1) / 8) * 90 + 70 * (1 - b.accuracy), 100, 70 * b.accuracy);
  }
  y += 220;
  for (const x of r.recommendations) {
    const words = t(x.key, x.vars).split(' ');
    let line = '• ';
    for (const w of words) { if (g.measureText(line + w).width > W - 160) { g.fillText(line, 80, y); y += 52; line = '  '; } line += `${w} `; }
    g.fillText(line, 80, y); y += 70;
  }
  g.font = '700 40px sans-serif'; g.fillText('Melovyn', 80, H - 70);
  return new Promise((res) => cv.toBlob((b) => b.arrayBuffer().then((x) => res(new Uint8Array(x))), 'image/png'));
}
