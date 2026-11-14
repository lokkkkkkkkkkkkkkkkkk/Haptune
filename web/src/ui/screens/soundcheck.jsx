// Sound check (More tools, and Practice settings): plays a test tone, measures how much of it the microphone
// hears back (feedback), the room's noise, the sample rates, the latency and the microphone's name. The result
// is kept and goes with problem reports, so a "noise on my phone" report says what the phone is doing.
import { useState } from 'preact/hooks';
import { toast } from '../state.js';
import { t } from '../../core/i18n.js';
import { Button, List, Row, Icon } from '../components.jsx';
import { NavBar } from './common.jsx';
import { soundCheck, deviceAudioLog } from '../audio.js';

export function SoundCheckView() {
  const [r, setR] = useState(() => deviceAudioLog().soundCheck);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { setR(await soundCheck()); } catch (e) { toast(t(e.code === 'denied' ? 'micDenied' : 'micUnavailable'), 'err'); }
    setBusy(false);
  };
  return (
    <div class="scroll" id="sound-check">
      <NavBar title={t('scT')} color="green" backLabel={t('back')} />
      <div class="wrap" style={{ paddingTop: 12 }}>
        <p class="note-text">{t('scSub')}</p>
        <Button kind="brand" full icon="speaker" disabled={busy} onClick={run} id="sc-run">{busy ? t('scRunning') : t('scRun')}</Button>
        {r && (
          <List>
            <Row icon="ear" color={r.roomDb > -35 ? 'orange' : 'green'} title={t('scRoom')} detail={`${r.roomDb} dB`} subtitle={r.roomDb > -35 ? t('scNoisy') : t('scQuiet')} />
            <Row icon="speaker" color={r.heard ? 'orange' : 'green'} title={t('scFeedback')} detail={`${r.feedbackDb > 0 ? '+' : ''}${r.feedbackDb} dB`} subtitle={r.heard ? t('scHeadphones') : t('scNoFeedback')} />
            <Row icon="wave" color="blue" title={t('scRates')} detail={`${r.playbackRate || '–'} / ${r.micRate || r.micContextRate || '–'}`} />
            <Row icon="clock" color="violet" title={t('scLatency')} detail={`${r.baseLatencyMs + r.outputLatencyMs} ms`} />
            <Row icon="mic" color="gray" title={t('scDevice')} subtitle={r.device || '–'} />
            {r.lowEnd && <Row icon="info" color="gray" title={t('scLowEnd')} />}
          </List>
        )}
        {r && <p class="tiny muted" style={{ textAlign: 'center' }}><Icon name="check" size={12} /> {r.at?.slice(0, 16).replace('T', ' ')}</p>}
      </div>
    </div>
  );
}
