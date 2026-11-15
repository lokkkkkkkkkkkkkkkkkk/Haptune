// "More tools": every secondary feature in one folded group at the bottom of Home, so the first screen stays
// about getting a sheet and practising it. Open or closed is remembered. Items that are not finished carry a
// Beta tag; nothing here is a top-level tab.
import { useState } from 'preact/hooks';
import { useApp, push, openSheet, go, toast } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, List, Row } from '../components.jsx';
import { NavBar } from './common.jsx';
import { VaryPanel } from './vary.jsx';
import { local } from '../storage.js';
import { tick } from '../native.js';

const dateSeed = () => { const d = new Date(); return d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate(); };

/** The items, in the order people look for them. `when` hides an item that cannot work right now. */
export function moreToolItems(s, { scan } = {}) {
  const last = [...(s.pieces || [])].filter((p) => p.kind === 'score').sort((a, b) => (b.opened || b.created || 0) - (a.opened || a.created || 0))[0];
  return [
    { id: 'add', icon: 'plus', color: 'blue', title: 'mtAdd', go: () => openSheet('add') },
    { id: 'scan', icon: 'camera', color: 'purple', title: 'mtScan', go: () => (scan ? scan() : openSheet('add')) },
    { id: 'jianpu', icon: 'pencil', color: 'red', title: 'mtJianpu', go: () => openSheet('paste') },
    { id: 'tuner', icon: 'tuningfork', color: 'teal', title: 'mtTunerMetro', go: () => push('tools') },
    { id: 'soundcheck', icon: 'speaker', color: 'green', title: 'mtSoundCheck', go: () => push('soundCheck') },
    { id: 'scales', icon: 'stairs', color: 'blue', title: 'mtScales', go: () => openSheet('scale') },
    { id: 'exercises', icon: 'book', color: 'orange', title: 'mtExercises', go: () => push('learnMore') },
    { id: 'ear', icon: 'ear', color: 'orange', title: 'mtEar', go: () => openSheet('lesson', { lessonId: 'ear2', seed: dateSeed(), daily: true }) },
    { id: 'improvise', icon: 'sparkles', color: 'pink', title: 'mtImprovise', go: () => push('improvise') },
    { id: 'vary', icon: 'wand', color: 'pink', title: 'mtVary', go: () => push('vary') },
    { id: 'compose', icon: 'staff', color: 'teal', title: 'mtCompose', go: () => openSheet('newSong') },
    { id: 'editor', icon: 'pencil', color: 'indigo', title: 'mtEditor', when: !!last, go: () => last && push('editor', { id: last.id }) },
    { id: 'daily', icon: 'bolt', color: 'orange', title: 'mtDaily', go: () => { go('community'); push('daily', {}, 'community'); } },
    { id: 'admin', icon: 'gear', color: 'gray', title: 'mtAdmin', when: s.me?.tier === 'dev', go: () => push('admin', {}, 'me') },
  ].filter((x) => x.when !== false);
}

export function MoreTools({ scan }) {
  const s = useApp();
  const [open, setOpen] = useState(() => local.get('moreToolsOpen', false));
  const toggle = () => { const v = !open; setOpen(v); local.set('moreToolsOpen', v); tick(); };
  const items = moreToolItems(s, { scan });
  return (
    <section class={`more-tools${open ? ' open' : ''}`} id="more-tools">
      <button type="button" class="mt-head" onClick={toggle} aria-expanded={open} id="more-tools-toggle">
        <span class="badge c-gray solid" style={{ width: 30, height: 30, borderRadius: 8 }}><Icon name="grid" size={18} stroke={2.1} /></span>
        <span class="mt-t"><strong>{t('moreTools')}</strong><span>{t('moreToolsSub')}</span></span>
        <Icon name="chevronR" size={16} stroke={2.4} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .25s' }} />
      </button>
      {open && (
        <div class="mt-body">
          <List>
            {items.map((x) => (
              <Row key={x.id} id={`mt-${x.id}`} icon={x.icon} color={x.color} title={<>{t(x.title)}{x.beta && <span class="pro-tag beta">{t('beta')}</span>}</>} onClick={() => { tick(); x.go(); }} />
            ))}
          </List>
        </div>
      )}
    </section>
  );
}

/** Vary a song (the variation panel that used to live only inside Improvise), as its own small page. */
export function VaryView({ active, src }) {
  return (
    <div class="scroll">
      <NavBar title={t('mtVary')} color="pink" backLabel={t('back')} />
      <div class="wrap c-pink" style={{ paddingTop: 12 }}><VaryPanel active={active} src={src} /></div>
    </div>
  );
}

export const _test = { dateSeed, toast };
