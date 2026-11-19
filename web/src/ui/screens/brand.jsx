// Developer mode > Brand (owner): the app's name and icon for the website, Google search and the Android app,
// with a preview of each. Saving commits web/brand.json and the icon (server/brand.py); GitHub then makes every
// icon size and rebuilds (.github/workflows/brand.yml). Without the GitHub settings it says what to set.
import { useEffect, useState } from 'preact/hooks';
import { toast } from '../state.js';
import { t } from '../../core/i18n.js';
import { Button, Icon } from '../components.jsx';
import { call } from '../api.js';
import { toBase64 } from '../google.js';

const toUrl = (svg, png) => (svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : png ? `data:image/png;base64,${png}` : '');

export function BrandPanel() {
  const [cur, setCur] = useState(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [short, setShort] = useState('');
  const [svg, setSvg] = useState('');
  const [png, setPng] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    call('/c/admin/brand').then((r) => { setCur(r); setName(r.name); setShort(r.short_name); }).catch((e) => setErr(e.message || String(e)));
  }, []);
  const pick = async (e) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    if (f.size > 400 * 1024) { setErr(t('brandTooBig')); return; }
    setErr('');
    if (f.type === 'image/svg+xml' || f.name.endsWith('.svg')) { setSvg(await f.text()); setPng(''); }
    else if (f.type === 'image/png') {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const img = new Image();
      const url = URL.createObjectURL(f);
      img.onload = () => { URL.revokeObjectURL(url); if (img.width < 512 || img.width !== img.height) setErr(t('brandPngSize')); else { setPng(toBase64(bytes)); setSvg(''); } };
      img.src = url;
    } else setErr(t('brandWhichFiles'));
  };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await call('/c/admin/brand', { method: 'POST', json: { name: name.trim(), short_name: short.trim(), icon_svg: svg, icon_png_b64: png }, timeout: 60000 });
      setSaved(true); toast(t('brandSaved'));
    } catch (e) { setErr(e.detail?.message || e.message || String(e)); }
    setBusy(false);
  };
  if (!cur) return err ? <p class="t-red">{err}</p> : <div class="loading"><div class="spinner" /></div>;
  const icon = toUrl(svg || cur.icon_svg, png || cur.icon_png) || 'icons/icon-192.png';
  const changed = name.trim() !== cur.name || short.trim() !== cur.short_name || !!svg || !!png;
  return (
    <section class="brand-panel" id="brand-panel">
      <p class="note-text">{t('brandHelp')}</p>
      <label class="field3"><span>{t('brandName')}</span><input id="brand-name" value={name} maxLength={30} onInput={(e) => { setName(e.currentTarget.value); setSaved(false); }} /></label>
      <label class="field3"><span>{t('brandShort')}</span><input id="brand-short" value={short} maxLength={12} onInput={(e) => { setShort(e.currentTarget.value); setSaved(false); }} /></label>
      <label class="field3"><span>{t('brandIcon')}</span><input id="brand-icon" type="file" accept="image/svg+xml,.svg,image/png" onChange={pick} /></label>
      <p class="tiny muted">{t('brandIconHelp')}</p>
      <div class="brand-prev" id="brand-preview">
        <div><span class="bp-tab"><img src={icon} alt="" /><span>{name || '—'}</span></span>{t('brandPrevTab')}</div>
        <div class="bp-serp"><span class="bp-tab"><img src={icon} alt="" /><span>haptune.name.my</span></span><b>{name || '—'}</b>{t('brandPrevGoogle')}</div>
        <div><img src={icon} alt="" /><strong>{short || name || '—'}</strong>{t('brandPrevPhone')}</div>
      </div>
      {!cur.configured && (
        <div class="banner" id="brand-setup"><Icon name="info" size={18} /><span>{t('brandSetup')}</span></div>
      )}
      {err && <p class="t-red tiny">{err}</p>}
      {saved && <p class="note-text" id="brand-saved"><Icon name="check" size={14} /> {t('brandSavedLong')}</p>}
      <Button full icon="check" disabled={busy || !cur.configured || !changed || name.trim().length < 2} onClick={save} id="brand-save">{t('save')}</Button>
    </section>
  );
}
