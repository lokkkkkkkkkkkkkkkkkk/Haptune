// "Show me around": Hapi points at the real buttons, one at a time (a spotlight with a speech card), after the
// three welcome cards on the first run. Skippable at every step; replay it from Settings, Help, Browse or the
// Home card. Works on phones (tab bar + menu) and wide screens (sidebar): each step names the button for both.
import { useEffect, useState } from 'preact/hooks';
import { Mascot } from './mascot.jsx';
import { Icon } from './components.jsx';
import { t } from '../core/i18n.js';
import { local } from './storage.js';
import { setState, getState, go, popToRoot, toast } from './state.js';

const STEPS = [
  { id: 'hello', mood: 'wave' },
  { id: 'home', sel: ['#side-homeTab', '#tab-homeTab'], mood: 'happy' },
  { id: 'create', sel: ['#side-newsong', '#tab-create'], mood: 'cheer' },
  { id: 'learn', sel: ['#side-hub', '#tab-hub'], mood: 'think' },
  { id: 'stage', sel: ['#side-stage', '#tab-stage'], mood: 'cheer' },
  { id: 'friends', sel: ['#side-placeFriends', '#home-menu'], mood: 'wave' },
  { id: 'browse', sel: ['#side-browse', '#home-browse'], mood: 'happy' },
  { id: 'ask', sel: ['#ai-fab'], mood: 'think', optional: true },
  { id: 'done', mood: 'cheer' },
];

const visible = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]');
};
const find = (sels = []) => {
  for (const s of sels) { const el = [...document.querySelectorAll(s)].find(visible); if (el) return el; }
  return null;
};

/** Starts the guide from the top of Home. From the welcome card, Hapi has already said hello. */
export function startCoach({ from = '' } = {}) {
  popToRoot('summary'); go('summary');
  setState({ drawer: false, sheet: null, coach: Date.now(), coachFrom: from });
}
export const coachDone = () => local.get('coachDone', false);

export function Coach({ from = '' }) {
  const steps = STEPS.filter((s) => (!s.optional || find(s.sel)) && !(from === 'welcome' && s.id === 'hello'));
  const [i, setI] = useState(0);
  const [box, setBox] = useState(null);
  const st = steps[Math.min(i, steps.length - 1)];
  useEffect(() => {
    let alive = true;
    const place = () => {
      const el = st.sel ? find(st.sel) : null;
      if (!el) { if (alive) setBox(null); return; }
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      if (alive) setBox({ x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 });
    };
    const id = setTimeout(place, 60);
    addEventListener('resize', place);
    return () => { alive = false; clearTimeout(id); removeEventListener('resize', place); };
  }, [i]);
  const end = (skipped) => {
    local.set('coachDone', true);
    setState({ coach: null });
    if (skipped) toast(t('coachLater'));
  };
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') end(true);
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      else if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1));
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });
  const next = () => { if (i >= steps.length - 1) end(false); else setI(i + 1); };
  const last = i >= steps.length - 1;
  // the card sits under the spotlight, or above it when the button is low on the screen (the tab bar)
  const vh = globalThis.innerHeight || 800, vw = globalThis.innerWidth || 400;
  const cardW = Math.min(360, vw - 24);
  let cardStyle = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: cardW };
  if (box) {
    const below = box.y + box.h + 14, above = box.y - 14;
    const left = Math.max(12, Math.min(vw - cardW - 12, box.x + box.w / 2 - cardW / 2));
    cardStyle = box.y + box.h / 2 > vh * 0.55 ? { left, bottom: vh - above, width: cardW } : { left, top: below, width: cardW };
  }
  return (
    <div class={`coach${box ? '' : ' center'}`} role="dialog" aria-modal="true" aria-label={t(`coach_${st.id}T`)} id="coach">
      {box ? <div class="coach-hole" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} /> : <div class="coach-dim" />}
      <div class="coach-card" style={cardStyle} key={st.id}>
        <div class="coach-top">
          <Mascot mood={st.mood} size={st.sel ? 58 : 84} />
          <div class="coach-txt">
            <strong>{t(`coach_${st.id}T`)}</strong>
            <p>{t(`coach_${st.id}`)}</p>
          </div>
        </div>
        <div class="coach-foot">
          <div class="coach-dots" aria-hidden="true">{steps.map((x, k) => <i key={x.id} class={k === i ? 'on' : k < i ? 'done' : ''} />)}</div>
          {!last && <button type="button" class="coach-skip" id="coach-skip" onClick={() => end(true)}>{t('tourSkip')}</button>}
          {i > 0 && <button type="button" class="coach-back" onClick={() => setI(i - 1)} aria-label={t('back')}><Icon name="chevronL" size={18} stroke={2.6} /></button>}
          <button type="button" class="coach-next" id="coach-next" onClick={next}>{last ? t('coachGo') : t('next')}{!last && <Icon name="chevronR" size={16} stroke={2.8} />}</button>
        </div>
      </div>
    </div>
  );
}
