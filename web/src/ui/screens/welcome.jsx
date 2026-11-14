// First-run tour: three cards (Practice; Learn; Create and Stage), skippable and shown once. Replay it from Settings.
import { useState } from 'preact/hooks';
import { useApp, updateSettings, closeSheet, go } from '../state.js';
import { t, instrumentName } from '../../core/i18n.js';
import { Chip, Button, Icon } from '../components.jsx';
import { local } from '../storage.js';

const PICK = ['piano', 'guitar', 'violin', 'voice', 'flute', 'cello', 'ukulele', 'erhu', 'sax', 'trumpet', 'dizi', 'clarinet'];

export function WelcomeSheet() {
  const s = useApp();
  const [i, setI] = useState(0);
  const finish = (then) => {
    local.set('welcomed', true);
    closeSheet();
    if (then) then();
  };
  // Three cards: what Practice, Learn, and Create + Stage are. Shown once (skippable); replay it from Settings.
  const slides = [
    { title: t('tour1T'), body: t('tour1'), icons: [['mic', 'violet']] },
    { title: t('tour2T'), body: t('tour2'), icons: [['academy', 'orange']] },
    { title: t('tour3T'), body: t('tour3'), icons: [['pencil', 'teal'], ['stage', 'pink']] },
  ];
  const sl = slides[i];
  return (
    <div class="sheet full welcome" role="dialog" aria-modal="true" aria-label={sl.title}>
      <div class="sheet-head">
        <span />
        <h2 aria-hidden="true" />
        <button type="button" class="r" id="tour-skip" onClick={() => finish()}>{t('tourSkip')}</button>
      </div>
      <div class="sheet-body" style={{ alignItems: 'center', textAlign: 'center', justifyContent: 'center' }} key={i}>
        <div class="tour-card">
          <div class="tour-pair fade-up">{sl.icons.map(([ic, c]) => <span key={ic} class={`tour-ic c-${c}`}><Icon name={ic} size={46} stroke={2} /></span>)}</div>
          <h2 class="fade-up d1" style={{ font: '800 28px/1.15 var(--round)' }}>{sl.title}</h2>
          <p class="fade-up d2" style={{ fontSize: 17, color: 'var(--ink2)', lineHeight: 1.45, margin: 0 }}>{sl.body}</p>
        </div>
        {i === 0 && (
          <div class="fade-up d3" style={{ width: '100%', maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <strong style={{ fontSize: 15 }}>{t('whatDoYouPlay')}</strong>
            <div class="choice-chips" style={{ justifyContent: 'center' }}>
              {PICK.map((k) => <Chip key={k} on={s.settings.instrument === k} color="purple" onClick={() => updateSettings({ instrument: k })}>{instrumentName(k)}</Chip>)}
            </div>
          </div>
        )}
        <div class="dots" aria-hidden="true" style={{ marginTop: 6 }}>{slides.map((_, k) => <i key={k} class={k === i ? 'on' : ''} style={{ '--c': '#B455F2' }} />)}</div>
        <div style={{ width: '100%', maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {i < slides.length - 1
            ? <Button kind="brand" full onClick={() => setI(i + 1)}>{t('next')} <Icon name="chevronR" size={18} stroke={2.6} /></Button>
            : <Button kind="brand" full icon="mic" id="tour-start" onClick={() => finish(() => go('summary'))}>{t('tourStart')}</Button>}
          {i > 0 && <Button kind="plain" full onClick={() => setI(i - 1)}>{t('back')}</Button>}
        </div>
      </div>
    </div>
  );
}
WelcomeSheet.modal = true;
WelcomeSheet.bare = true;
