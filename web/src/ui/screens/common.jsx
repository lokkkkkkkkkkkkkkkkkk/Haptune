import { useState, useRef, useEffect } from 'preact/hooks';
import { useApp, pop, closeSheet, go } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon } from '../components.jsx';

export function Avatar() {
  const s = useApp();
  const initials = (s.settings.name || '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <button type="button" class="avatar" onClick={() => go('me')} aria-label={t('me')}>
      {initials || <Icon name="person" size={18} />}
      {s.plus && <span class="crown"><Icon name="crown" size={11} stroke={2.6} /></span>}
    </button>
  );
}

/** The iOS large title: big at the top of a page, and once the page scrolls under it, a small centred title in a
 *  frosted bar (like Settings, Reminders and Health). */
export function LargeTitle({ title, eyebrow, actions, color, back = false, avatar = false }) {
  const ref = useRef(null);
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const sc = ref.current?.closest('.scroll');
    if (!sc) return undefined;
    const on = () => setSmall(sc.scrollTop > 48);
    sc.addEventListener('scroll', on, { passive: true });
    on();
    return () => sc.removeEventListener('scroll', on);
  }, []);
  return (
    <>
      <div class={`lt-bar c-${color || 'violet'}${small ? ' on' : ''}`} aria-hidden={small ? undefined : 'true'}>
        {back ? <button type="button" class="lt-back" tabIndex={small ? 0 : -1} onClick={() => pop()} aria-label={t('back')}><Icon name="chevronL" size={22} stroke={2.6} /></button> : <span />}
        <span class="lt-title">{title}</span><span />
      </div>
      <header ref={ref} class={`large-title c-${color || 'violet'}`}>
        <div>
          {back && <button type="button" class="back-btn" onClick={() => pop()} aria-label={t('back')}><Icon name="chevronL" size={20} stroke={2.6} /></button>}
          <div style={{ minWidth: 0 }}>
            {eyebrow && <div class="eyebrow">{eyebrow}</div>}
            <h1>{title}</h1>
          </div>
        </div>
        <div class="title-actions">{actions}{avatar && <Avatar />}</div>
      </header>
    </>
  );
}

// Visual width of a title in "Latin character" units (CJK glyphs count double).
const titleWidth = (s) => [...String(s || '')].reduce((n, ch) => n + (/[\u2E80-\uFFEF]/.test(ch) ? 2 : 1), 0);

export function NavBar({ title, actions, color = 'blue', backLabel }) {
  const label = backLabel || t('back');
  // Like iOS: when the title is long, the back button collapses to just the chevron.
  const compact = titleWidth(title) + titleWidth(label) > 26;
  return (
    <div class={`navbar c-${color}`}>
      <button type="button" class="back" onClick={() => pop()} aria-label={label}><Icon name="chevronL" size={22} stroke={2.6} />{!compact && <span>{label}</span>}</button>
      <div class="nav-title">{title}</div>
      <div class="nav-actions">{actions}</div>
    </div>
  );
}

export function SheetFrame({ title, children, right, onRight, rightDisabled, full, left, onLeft }) {
  return (
    <div class={`sheet${full ? ' full' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <div class="sheet-head">
        {left === false ? <span /> : <button type="button" class="l" onClick={onLeft || closeSheet}>{left || t('close')}</button>}
        <h2>{title}</h2>
        {right ? <button type="button" class="r" onClick={onRight} disabled={rightDisabled} style={rightDisabled ? { opacity: 0.4 } : null}>{right}</button> : <span />}
      </div>
      <div class="sheet-body">{children}</div>
    </div>
  );
}

export const dateLabel = (lang) => {
  try { return new Date().toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long' }); } catch { return ''; }
};

/** The Melovyn mark: Hapi, the app icon (made from web/brand.json by tools/brand.cjs, so it follows a new icon). */
export function Logo({ size = 30 }) {
  return <img class="logo-svg" src="icons/icon-96.png" width={size} height={size} alt="" style={{ borderRadius: Math.round(size * 0.24) }} />;
}
