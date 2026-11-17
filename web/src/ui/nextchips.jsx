// "What next": the row of chips that ends every flow (a take, handing in, a new song, a Stage post, a Sound,
// joining a class), so there is always a next step one tap away. The choices come from core/piece.js nextSteps();
// each screen passes what each chip does (`on`), and chips it can't do are left out.
import { nextSteps } from '../core/piece.js';
import { t } from '../core/i18n.js';
import { Icon } from './components.jsx';
import { tick } from './native.js';
import { track } from './analytics.js';
import { shareURL } from '../core/piece.js';
import { toast } from './state.js';

/** Copies the web address of an item (core/piece.js linkFor) or shares it on phones. */
export async function copyLink(item, action) {
  const url = shareURL(globalThis.HAPTUNE_CONFIG?.site || location.origin, item, action);
  if (!url) return;
  try { if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) { await navigator.share({ title: item.title, url }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast(t('linkCopied')); } catch { toast(url); }
}

export function NextChips({ flow, ctx = {}, on = {}, id = 'next-chips' }) {
  const steps = nextSteps(flow, ctx).filter((x) => typeof on[x.id] === 'function');
  if (!steps.length) return null;
  return (
    <div class="next-chips" id={id} role="group" aria-label={t('whatNext')}>
      <span class="nx-k">{t('whatNext')}</span>
      <div class="nx-row">
        {steps.map((x) => (
          <button type="button" key={x.id} id={`nx-${x.id}`} class={`nx${x.primary ? ' primary' : ''}`}
            onClick={() => { tick(); track('next_step', { label: `${flow}:${x.id}` }); on[x.id](); }}>
            <Icon name={x.icon} size={15} stroke={2.3} />{t(x.label)}
          </button>
        ))}
      </div>
    </div>
  );
}
