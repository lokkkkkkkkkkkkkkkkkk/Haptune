// First run: one clean card (Hapi says hello and asks what you play), then "Show me around" points at the real
// buttons (coach.jsx). Skip at any step; see it again any time in Settings › Guide or Help.
import { useApp, updateSettings, closeSheet, go, getState } from '../state.js';
import { t, instrumentName } from '../../core/i18n.js';
import { Chip, Button, Icon } from '../components.jsx';
import { local } from '../storage.js';
import { Mascot } from '../mascot.jsx';
import { startCoach } from '../coach.jsx';

const PICK = ['piano', 'guitar', 'violin', 'voice', 'flute', 'cello', 'ukulele', 'erhu', 'sax', 'trumpet', 'dizi', 'clarinet'];

export function WelcomeSheet() {
  const s = useApp();
  const finish = (guide) => {
    local.set('welcomed', true);
    closeSheet();
    go('summary');
    // came from a search on the website: carry on to that song (the Home card offers the guide later)
    if (guide && !getState().stacks.summary.length) setTimeout(() => startCoach({ from: 'welcome' }), 350);
  };
  return (
    <div class="sheet full welcome w2" role="dialog" aria-modal="true" aria-label={t('coach_helloT')}>
      <div class="sheet-head">
        <span />
        <h2 aria-hidden="true" />
        <button type="button" class="r" id="tour-skip" onClick={() => finish(false)}>{t('tourSkip')}</button>
      </div>
      <div class="sheet-body w2-body">
        <div class="w2-hapi fade-up"><Mascot mood="wave" size={132} /></div>
        <h2 class="fade-up d1">{t('coach_helloT')}</h2>
        <p class="fade-up d1 w2-lead">{t('w2Lead')}</p>
        <div class="w2-ways fade-up d2" aria-hidden="true">
          {[['mic', 'violet', 'w2Practise'], ['academy', 'orange', 'w2Learn'], ['pencil', 'teal', 'w2Create'], ['stage', 'pink', 'w2Share']].map(([ic, c, k]) => (
            <span key={k} class={`w2-way c-${c}`}><Icon name={ic} size={16} stroke={2.3} />{t(k)}</span>
          ))}
        </div>
        <div class="fade-up d3 w2-pick">
          <strong>{t('whatDoYouPlay')}</strong>
          <div class="choice-chips">
            {PICK.map((k) => <Chip key={k} on={s.settings.instrument === k} color="purple" onClick={() => updateSettings({ instrument: k })}>{instrumentName(k)}</Chip>)}
          </div>
        </div>
        <div class="w2-btns">
          <Button kind="brand" full icon="sparkles" id="tour-start" onClick={() => finish(true)}>{t('coachStart')}</Button>
          <Button kind="plain" full id="tour-no-guide" onClick={() => finish(false)}>{t('w2Later')}</Button>
        </div>
      </div>
    </div>
  );
}
WelcomeSheet.modal = true;
WelcomeSheet.bare = true;
