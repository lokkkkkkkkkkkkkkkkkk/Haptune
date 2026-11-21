// Note input shaped like the instrument being written: a guitar, bass or ukulele fretboard, a violin, viola,
// cello or erhu fingerboard (with the first-position fingers marked), as well as the piano keys and drum pads
// the studio already had. A tap gives the sounding note; the studio writes it at the part's written pitch.
import { pitchName, spellMidi } from '../core/pitch.js';

export const BOARDS = {
  guitar: { strings: [40, 45, 50, 55, 59, 64], frets: 15, fretted: true },
  bass: { strings: [28, 33, 38, 43], frets: 15, fretted: true },
  ukulele: { strings: [67, 60, 64, 69], frets: 12, fretted: true },
  violin: { strings: [55, 62, 69, 76], frets: 12 },
  viola: { strings: [48, 55, 62, 69], frets: 12 },
  cello: { strings: [36, 43, 50, 57], frets: 12, cello: true },
  doublebass: { strings: [28, 33, 38, 43], frets: 12, cello: true },
  erhu: { strings: [62, 69], frets: 14 },
};
/** The input a part starts with. */
export function boardFor(instrument) {
  if (instrument === 'drums') return 'drums';
  if (instrument === 'bassguitar') return 'bass';
  if (['guitar', 'mandolin', 'pipa'].includes(instrument)) return 'guitar';
  if (BOARDS[instrument]) return instrument;
  return 'piano';
}
const MARKERS = new Set([3, 5, 7, 9, 12, 15]);
// first position: which finger plays each semitone above the open string
const VIOLIN_FINGER = [0, 1, 1, 2, 2, 3, 3, 4];
const CELLO_FINGER = [0, 1, 1, 2, 3, 4];

export function Fingerboard({ kind, keyFifths = 0, onNote, labels = true }) {
  const B = BOARDS[kind];
  if (!B) return null;
  const rows = [...B.strings].map((open, si) => ({ open, si })).reverse(); // highest string on top, as players look at it
  const fing = B.cello ? CELLO_FINGER : VIOLIN_FINGER;
  return (
    <div class={`fboard ${B.fretted ? 'fretted' : 'bowed'}`} id={`fb-${kind}`} role="group" aria-label={kind}>
      <div class="fb-grid" style={{ '--frets': B.frets + 1 }}>
        {rows.map(({ open, si }) => (
          <div class="fb-row" key={si}>
            {Array.from({ length: B.frets + 1 }, (_, f) => {
              const midi = open + f;
              const nm = pitchName(spellMidi(midi, keyFifths));
              const finger = !B.fretted && f < fing.length ? fing[f] : null;
              return (
                <button type="button" key={f} class={`fb-cell${f === 0 ? ' open' : ''}${finger !== null ? ` f${finger}` : ''}`} onClick={() => onNote(midi)} aria-label={nm} id={`fb-${kind}-${si}-${f}`}>
                  {labels && <span class="nm">{nm.replace(/\d+$/, '')}</span>}
                  {finger !== null && f > 0 && <span class="fg">{finger}</span>}
                </button>
              );
            })}
          </div>
        ))}
        <div class="fb-frets" aria-hidden="true">{Array.from({ length: B.frets + 1 }, (_, f) => <span key={f}>{B.fretted ? (MARKERS.has(f) ? f : '') : f === 0 ? '0' : ''}</span>)}</div>
      </div>
    </div>
  );
}
