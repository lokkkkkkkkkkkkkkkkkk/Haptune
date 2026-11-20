// Browse (Apple Health's Browse): a search box, then every part of Haptune as a colour tile, then the everyday
// settings. The same places as the sidebar's Categories (places.js).
import { useState } from 'preact/hooks';
import { push, openSheet, go, popToRoot } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, List, Row } from '../components.jsx';
import { NavBar } from './common.jsx';
import { PLACES, MAIN, gradOf } from '../places.js';
import { Mascot } from '../mascot.jsx';
import { startCoach } from '../coach.jsx';
import { tick } from '../native.js';

// Browse shows everything: the main places (Learning hub, Stage, Friends) first, then the Categories
const ALL = [
  ...MAIN.filter((x) => x.id !== 'home' && x.id !== 'browse').map((x) => ({ ...x, to: x.to || (() => { popToRoot(x.tab); go(x.tab); }) })),
  ...PLACES,
];

export function BrowseView() {
  const [q, setQ] = useState('');
  const find = (e) => { e.preventDefault(); if (q.trim()) push('find', { q: q.trim() }); };
  return (
    <div class="scroll" id="browse">
      <NavBar title={t('browse')} backLabel={t('homeTab')} color="teal" />
      <div class="wrap">
        <div class="page-hapi"><Mascot mood="happy" size={64} /><p>{t('browseHapi')}</p></div>
        <form class="browse-search" onSubmit={find} role="search">
          <Icon name="search" size={18} />
          <input id="browse-q" type="search" value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('browseSearch')} aria-label={t('browseSearch')} />
        </form>
        <h2 class="browse-h">{t('everythingT')}</h2>
        <div class="browse-grid" id="browse-grid">
          {ALL.map((p) => (
            <button type="button" key={p.id} class="browse-tile" id={`browse-${p.id}`} style={{ background: gradOf(p) }} onClick={() => { tick(); p.to(); }}>
              <Icon name={p.icon} size={30} stroke={2} /><strong>{t(p.label)}</strong>
            </button>
          ))}
        </div>
        <h2 class="browse-h">{t('everydayT')}</h2>
        <List>
          <Row icon="sparkles" color="violet" title={t('coachReplayT')} subtitle={t('coachReplayS')} onClick={() => startCoach()} id="browse-tour" />
          <Row icon="gear" color="gray" title={t('settings')} onClick={() => openSheet('account')} />
          <Row icon="link" color="blue" title={t('connectionsT')} onClick={() => openSheet('connections')} />
          <Row icon="crown" color="orange" title={t('seePlans')} onClick={() => openSheet('plans')} />
        </List>
      </div>
    </div>
  );
}
