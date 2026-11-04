import { useApp, openSheet, pop, closeSheet } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon } from '../components.jsx';

export function Avatar() {
  const s = useApp();
  const initials = (s.settings.name || '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <button type="button" class="avatar" onClick={() => openSheet('account')} aria-label={t('account')}>
      {initials || <Icon name="person" size={18} />}
      {s.plus && <span class="crown"><Icon name="crown" size={11} stroke={2.6} /></span>}
    </button>
  );
}

export function LargeTitle({ title, eyebrow, actions, color }) {
  return (
    <header class={`large-title c-${color || 'blue'}`}>
      <div>
        {eyebrow && <div class="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
      </div>
      <div class="title-actions">{actions}<Avatar /></div>
    </header>
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
