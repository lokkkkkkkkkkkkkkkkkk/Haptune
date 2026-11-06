// First-run guide: Hapi says hello, asks what you play, then three quick tips. Replay it from Account.
import { useState } from 'preact/hooks';
import { useApp, updateSettings, closeSheet, openSheet, go } from '../state.js';
import { t, instrumentName } from '../../core/i18n.js';
import { Chip, Button, Icon } from '../components.jsx';
import { Mascot } from '../mascot.jsx';
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
  const slides = [
    { mood: 'wave', title: t('welcomeHapi'), body: t('welcomeHapiSub') },
    { mood: 'think', title: t('tip1Title'), body: t('welcomeAdd'), icon: 'folder', color: 'purple' },
    { mood: 'listen', title: t('tip2Title'), body: t('tip2'), icon: 'mic', color: 'pink' },
    { mood: 'cheer', title: t('welcomeCommunityTitle'), body: t('welcomeCommunity'), icon: 'users', color: 'orange' },
  ];
  const sl = slides[i];
  return (
    <div class="sheet full welcome" role="dialog" aria-modal="true" aria-label={t('welcomeHapi')}>
      <div class="sheet-head">
        <span />
        <h2 aria-hidden="true" />
        <button type="button" class="r" onClick={() => finish()}>{t('skip')}</button>
      </div>
      <div class="sheet-body" style={{ alignItems: 'center', textAlign: 'center', justifyContent: 'center' }} key={i}>
        <div class="fade-up"><Mascot mood={sl.mood} size={150} label="Hapi" /></div>
        <h2 class="fade-up d1" style={{ font: '800 28px/1.15 var(--round)' }}>{sl.title}</h2>
        <p class="fade-up d2" style={{ fontSize: 17, color: 'var(--ink2)', maxWidth: 420, lineHeight: 1.45 }}>{sl.body}</p>
        {i === 0 && (
          <div class="fade-up d3" style={{ width: '100%', maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input class="field" type="text" placeholder={t('yourName')} value={s.settings.name || ''} onInput={(e) => updateSettings({ name: e.currentTarget.value })} aria-label={t('yourName')} style={{ textAlign: 'center' }} />
            <strong style={{ fontSize: 16 }}>{t('whatDoYouPlay')}</strong>
            <div class="choice-chips" style={{ justifyContent: 'center' }}>
              {PICK.map((k) => <Chip key={k} on={s.settings.instrument === k} color="purple" onClick={() => updateSettings({ instrument: k })}>{instrumentName(k)}</Chip>)}
            </div>
          </div>
        )}
        <div class="dots" aria-hidden="true" style={{ marginTop: 6 }}>{slides.map((_, k) => <i key={k} class={k === i ? 'on' : ''} style={{ '--c': '#B455F2' }} />)}</div>
        <div style={{ width: '100%', maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {i < slides.length - 1
            ? <Button kind="brand" full onClick={() => setI(i + 1)}>{t('next')} <Icon name="chevronR" size={18} stroke={2.6} /></Button>
            : <>
                <Button kind="brand" full icon="plus" onClick={() => finish(() => { go('library'); openSheet('add'); })}>{t('addMusic')}</Button>
                <Button kind="secondary" full color="purple" icon="users" onClick={() => finish(() => go('community'))}>{t('openCommunity')}</Button>
                <Button kind="plain" full onClick={() => finish(() => go('summary'))}>{t('letsGo')}</Button>
              </>}
          {i > 0 && <Button kind="plain" full onClick={() => setI(i - 1)}>{t('back')}</Button>}
        </div>
      </div>
    </div>
  );
}
WelcomeSheet.modal = true;
WelcomeSheet.bare = true;
