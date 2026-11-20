// The score reader's notes on a bar, in words: which staff and what is wrong (server: engine/haptune/ai/reader.py).
import { t } from '../core/i18n.js';

/** A flagged bar in words: which staff and what is wrong (from the reader's issue codes). */
export function issueLines(f) {
  const list = (f.issues || []).length ? f.issues : (f.reasons || []).slice(0, 1).map((r) => ({ code: '', where: '', text: r }));
  return list.slice(0, 3).map((x) => {
    if (x.code === 'unsure') {
      const why = x.text.replace(/^reader unsure:?\s*/, '');
      return { where: x.where, text: why ? `${t('rdi_unsure')} ${why}` : t('rdi_unsure') };
    }
    const k = `rdi_${x.code}`;
    return { where: x.where, text: x.code && x.code !== 'notation' && t(k) !== k ? t(k) : x.text };
  });
}
