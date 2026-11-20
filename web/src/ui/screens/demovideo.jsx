// "Haptune in 1 minute": the demo video, for new people (the welcome card), Settings › Guide and Help.
// The file stays on the website (CONFIG.site + /media/...) so the app download doesn't grow; it streams when tapped.
import { useState } from 'preact/hooks';
import { t } from '../../core/i18n.js';
import { Icon } from '../components.jsx';
import { Mascot } from '../mascot.jsx';
import { SheetFrame } from './common.jsx';

export function demoVideoUrl(ext = 'mp4') {
  const cfg = globalThis.HAPTUNE_CONFIG || {};
  const file = `media/haptune-demo.${ext}`;
  if (cfg.native) return `${String(cfg.site || 'https://haptune.name.my').replace(/\/+$/, '')}/${file}`;
  try { return new URL(`../${file}`, location.href).href; } catch { return `/${file}`; }
}

/** A tappable thumbnail that turns into the player in place. */
export function DemoVideo({ id = 'demo-video', autoplay = false, compact = false }) {
  const [on, setOn] = useState(autoplay);
  const [failed, setFailed] = useState(false);
  if (!on) {
    return (
      <button type="button" class={`demo-thumb${compact ? ' compact' : ''}`} id={id} onClick={() => setOn(true)} aria-label={t('watchVideo')}>
        <span class="dt-hapi" aria-hidden="true"><Mascot mood="wave" size={compact ? 52 : 74} /></span>
        <span class="dt-text"><strong>{t('watchVideo')}</strong><span>{t('demoVideoS')}</span></span>
        <span class="dt-play" aria-hidden="true"><Icon name="play" size={compact ? 18 : 22} stroke={2.4} /></span>
      </button>
    );
  }
  return (
    <div class={`demo-player${compact ? ' compact' : ''}`}>
      {failed ? <p class="demo-off">{t('videoNeedsNet')}</p> : (
        <video id={`${id}-player`} class="demo-video" src={demoVideoUrl()} poster={demoVideoUrl('jpg')} controls playsInline autoPlay preload="auto"
          onError={() => setFailed(true)} />
      )}
    </div>
  );
}

export function DemoVideoSheet() {
  return (
    <SheetFrame title={t('demoVideoT')}>
      <DemoVideo id="sheet-video" autoplay />
      <p class="sub" style={{ marginTop: 14, textAlign: 'center' }}>{t('demoVideoS')}</p>
    </SheetFrame>
  );
}
