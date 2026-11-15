// Practice: pick a sheet, then play along. Reached from the Practice tile on Home, so any playable sheet is two
// taps from opening the app: Practice → the piece. Recent pieces first, then free pieces suited to your
// instrument, then a way to get anything else.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useApp, push, openSheet, go, toast } from '../state.js';
import { t, getLang, instrumentName } from '../../core/i18n.js';
import { Icon, List, Row, Section } from '../components.jsx';
import { LargeTitle } from './common.jsx';
import { loadCatalog, searchCatalog, addCatalogPiece, norm } from '../catalog.js';
import { tick } from '../native.js';

/** Free pieces that suit an instrument and are easy to start with; the same every day for a while. */
export function suggestFor(catalog, instrument, have = new Set(), n = 6) {
  if (!catalog?.length) return [];
  const want = { piano: ['piano', 'classical', 'song'], keyboard: ['piano', 'song'], guitar: ['folk', 'song', 'celtic'], ukulele: ['song', 'folk', 'kids'],
    violin: ['celtic', 'folk', 'classical'], voice: ['song', 'hymn', 'folk'], flute: ['celtic', 'folk', 'classical'], erhu: ['chinese', 'folk'], guzheng: ['chinese', 'folk'] }[instrument] || ['song', 'folk', 'classical'];
  const pool = catalog.filter((r) => !have.has(r.id));
  const ranked = pool.map((r, i) => ({ r, s: (r.instrument === instrument ? 0 : 3000) + (want.indexOf(r.genre) + 1 || 9) * 1000 + ((r.level || 2) * 100) + (i % 97) })).sort((a, b) => a.s - b.s);
  const week = Math.floor(Date.now() / (7 * 86400000));
  const top = ranked.slice(0, Math.max(n * 4, n));
  const out = [];
  for (let k = 0; k < top.length && out.length < n; k++) out.push(top[(k * 7 + week) % top.length].r);
  return [...new Set(out)];
}

export function PracticeView() {
  const s = useApp();
  const lang = getLang();
  const [catalog, setCatalog] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => { loadCatalog().then(setCatalog); }, [lang]);
  const query = q.trim();
  const recent = useMemo(() => [...s.pieces].filter((p) => p.kind === 'score').sort((a, b) => (b.opened || b.created || 0) - (a.opened || a.created || 0)), [s.pieces]);
  const have = useMemo(() => new Set(s.pieces.map((p) => p.catalogId).filter(Boolean)), [s.pieces]);
  const sugg = useMemo(() => suggestFor(catalog, s.settings.instrument, have), [catalog, s.settings.instrument, have]);
  const mine = useMemo(() => {
    if (!query) return [];
    const words = norm(query).split(' ').filter(Boolean);
    return recent.filter((p) => { const k = norm(`${p.title} ${p.composer || ''}`); return words.every((w) => k.includes(w)); }).slice(0, 6);
  }, [query, recent]);
  const free = useMemo(() => (catalog && query ? searchCatalog(catalog, query, { limit: 8 }) : []), [catalog, query]);
  const openFree = async (r) => { tick(); try { const rec = await addCatalogPiece(r); if (rec) push('piece', { id: rec.id }); } catch (e) { toast(e.message || String(e), 'err'); } };
  const openMine = (p) => { tick(); push('piece', { id: p.id }); };

  return (
    <div class="scroll" id="practice">
      <div class="wrap">
        <LargeTitle title={t('practiceT')} eyebrow={t('practiceEyebrow')} back color="violet" />
        <form class="ios-search" role="search" onSubmit={(e) => e.preventDefault()}>
          <Icon name="search" size={17} stroke={2.4} />
          <input id="practice-search" type="search" enterkeyhint="search" autocomplete="off" placeholder={t('practiceSearchPh')} value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label={t('practiceSearchPh')} />
          {q && <button type="button" class="ios-cancel" onClick={() => setQ('')}>{t('cancel')}</button>}
        </form>
        {query ? (
          <>
            {mine.length > 0 && <Section title={t('inYourLibrary')}><List>{mine.map((p) => <Row key={p.id} icon="library" color="blue" title={p.title} subtitle={p.composer} onClick={() => openMine(p)} />)}</List></Section>}
            {free.length > 0 && <Section title={t('freeLibrary')}><List>{free.map((r) => <Row key={r.id} icon="note1" color="violet" title={r.title} subtitle={r.composer} onClick={() => openFree(r)} />)}</List></Section>}
            {!mine.length && !free.length && catalog && <Section><List><Row icon="stage" color="pink" title={t('askStage')} subtitle={t('askStageSub')} onClick={() => openSheet('compose', { type: 'request', title: query })} /></List></Section>}
          </>
        ) : (
          <>
            {recent.length > 0 && (
              <Section title={t('continueWhere')}>
                <List>{recent.slice(0, 4).map((p, i) => <Row key={p.id} id={i === 0 ? 'practice-recent' : undefined} icon="library" color="blue" title={p.title}
                  subtitle={p.best != null ? `${t('rightNotes')}: ${p.best}%` : p.composer} onClick={() => openMine(p)} />)}</List>
              </Section>
            )}
            <Section title={t('suggestedForYou', { inst: instrumentName(s.settings.instrument || 'piano') })}>
              {!catalog ? <div class="loading" style={{ padding: 12 }}><div class="spinner small" /></div> : (
                <List>{sugg.map((r, i) => <Row key={r.id} id={i === 0 ? 'practice-suggest' : undefined} icon="note1" color="violet" title={r.title} subtitle={[r.composer, t(`genre_${r.genre}`)].filter(Boolean).join(' · ')} onClick={() => openFree(r)} />)}</List>
              )}
            </Section>
            <Section>
              <List>
                <Row icon="plus" color="green" title={t('getNewSheet')} subtitle={t('getNewSheetSub')} onClick={() => openSheet('add')} id="practice-add" />
                <Row icon="library" color="blue" title={t('allMySheets')} detail={s.pieces.length} onClick={() => go('library')} />
              </List>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
