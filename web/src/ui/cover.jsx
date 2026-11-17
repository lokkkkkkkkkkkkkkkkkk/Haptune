// Cover art for any piece, Sound or post that has none: generated from its title, key and instrument in one
// consistent style (a soft gradient in the instrument's colour, a staff motif, the key and the first letters of
// the title), so every shelf looks finished. Same input, same cover, on every device.
import { Icon } from './components.jsx';

/** The colour of each instrument (also used for mixer tracks and instrument chips). */
export const INSTRUMENT_HUE = {
  piano: 250, keys: 250, organ: 265, violin: 18, viola: 28, cello: 8, bass: 210, guitar: 32, ukulele: 45, voice: 330,
  flute: 175, recorder: 160, clarinet: 195, oboe: 150, saxophone: 40, trumpet: 48, drums: 0, erhu: 355, guzheng: 12,
};
const GENRE_GLYPH = { classical: '𝄞', piano: '𝄢', guitar: '♯', folk: '♪', song: '♫', hymn: '♩', kids: '♬', christmas: '❄', jazz: '♭', chinese: '♪', celtic: '♫', choral: '𝄐', dance: '♬', chamber: '𝄡', sound: '∿' };

export function hashOf(s) {
  let h = 2166136261;
  for (const ch of String(s || '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** {from, to, ink} colours for a cover. */
export function coverColors({ title = '', instrument = '', genre = '' }) {
  const h = hashOf(title);
  const base = INSTRUMENT_HUE[instrument] ?? (h % 360);
  const hue2 = (base + 28 + (h % 40)) % 360;
  return { from: `hsl(${base} 72% 62%)`, to: `hsl(${hue2} 68% 46%)`, glyph: GENRE_GLYPH[genre] || '♪' };
}

const initials = (title) => String(title || '♪').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '♪';

export function Cover({ title, instrument, genre, keyText, size = 'md', badge, icon }) {
  const c = coverColors({ title, instrument, genre });
  return (
    <span class={`cover-art cv-${size}`} style={{ '--cv-from': c.from, '--cv-to': c.to }} aria-hidden="true">
      <svg class="cv-staff" viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M0 34h100M0 42h100M0 50h100M0 58h100M0 66h100" /></svg>
      <span class="cv-glyph">{c.glyph}</span>
      <span class="cv-init">{initials(title)}</span>
      {keyText && <span class="cv-key">{keyText}</span>}
      {icon && <span class="cv-icon"><Icon name={icon} size={14} stroke={2.4} /></span>}
      {badge && <span class="cv-badge">{badge}</span>}
    </span>
  );
}
