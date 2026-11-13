import { useState } from 'preact/hooks';
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

export function LargeTitle({ title, eyebrow, actions, color, back = false, avatar = false }) {
  return (
    <header class={`large-title c-${color || 'violet'}`}>
      <div>
        {back && <button type="button" class="back-btn" onClick={() => pop()} aria-label={t('back')}><Icon name="chevronL" size={20} stroke={2.6} /></button>}
        <div style={{ minWidth: 0 }}>
          {eyebrow && <div class="eyebrow">{eyebrow}</div>}
          <h1>{title}</h1>
        </div>
      </div>
      <div class="title-actions">{actions}{avatar && <Avatar />}</div>
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

/** The ETASheet mark: a note head on a staff line, in the brand gradient. */
let logoSeq = 0;
export function Logo({ size = 30 }) {
  // each mark has its own gradient id: a gradient inside a hidden copy (the sidebar on phones) would paint nothing
  const [id] = useState(() => `etaLogo${++logoSeq}`);
  return (
    <svg class="logo-svg" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5B5BF6" /><stop offset=".55" stop-color="#9B5CF6" /><stop offset="1" stop-color="#F65C9B" /></linearGradient></defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id})`} />
      <path d="M7 21.5h18M7 16.5h18M7 11.5h18" stroke="#fff" stroke-opacity=".35" stroke-width="1.4" />
      <ellipse cx="13" cy="21.3" rx="4.2" ry="3.2" transform="rotate(-20 13 21.3)" fill="#fff" />
      <path d="M16.6 20V7.5c2.8.6 5.6 2.4 6.4 5.3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" />
    </svg>
  );
}
