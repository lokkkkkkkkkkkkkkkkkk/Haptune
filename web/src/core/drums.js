// The drum kit on a five-line percussion staff (where each drum and cymbal sits, its notehead, and the sound
// it makes). Shared by the studio (writing, grooves) and playback.
// the five-line drum staff (as MuseScore and most method books write it)
export const KIT = [
  { id: 'kick', step: 'F', oct: 4, head: null, drum: 'kick', stem: 'down' },
  { id: 'snare', step: 'C', oct: 5, head: null, drum: 'snare', stem: 'down' },
  { id: 'rim', step: 'C', oct: 5, head: 'circle-x', drum: 'rim', stem: 'down' },
  { id: 'hihat', step: 'G', oct: 5, head: 'x', drum: 'hat', stem: 'up' },
  { id: 'openhat', step: 'G', oct: 5, head: 'circle-x', drum: 'ohat', stem: 'up' },
  { id: 'pedalhat', step: 'D', oct: 4, head: 'x', drum: 'pedal', stem: 'down' },
  { id: 'ride', step: 'F', oct: 5, head: 'x', drum: 'ride', stem: 'up' },
  { id: 'crash', step: 'A', oct: 5, head: 'x', drum: 'crash', stem: 'up' },
  { id: 'tom1', step: 'E', oct: 5, head: null, drum: 'tom-h', stem: 'up' },
  { id: 'tom2', step: 'D', oct: 5, head: null, drum: 'tom-m', stem: 'up' },
  { id: 'floortom', step: 'A', oct: 4, head: null, drum: 'tom-l', stem: 'down' },
];
// General MIDI drum keys → the app's drum sounds
const GM = { 35: 'kick', 36: 'kick', 37: 'rim', 38: 'snare', 39: 'rim', 40: 'snare', 41: 'tom-l', 42: 'hat', 43: 'tom-l', 44: 'pedal', 45: 'tom-m', 46: 'ohat',
  47: 'tom-m', 48: 'tom-h', 49: 'crash', 50: 'tom-h', 51: 'ride', 52: 'crash', 53: 'ride', 54: 'hat', 55: 'crash', 56: 'rim', 57: 'crash', 59: 'ride' };
export const gmDrum = (key) => GM[key] || (key < 41 ? 'kick' : key < 51 ? 'tom-m' : 'hat');
/** The kit piece that shows a General MIDI drum key on the staff. */
export const kitForGm = (key) => {
  const d = gmDrum(key);
  return KIT.find((k) => k.drum === d) || KIT[1];
};
/** Which drum a note on the drum staff plays (for playback). */
export function drumOf(n) {
  if (!n?.unpitched) return null;
  if (typeof n.gm === 'number') return gmDrum(n.gm);
  const head = (n.noteheadXml || '').match(/>([a-z-]+)</)?.[1] || null;
  const hit = KIT.find((k) => k.step === n.unpitched.step && k.oct === n.unpitched.octave && (k.head || null) === head)
    || KIT.find((k) => k.step === n.unpitched.step && k.oct === n.unpitched.octave);
  if (hit) return hit.drum;
  // a position this kit doesn't use: guess from the notehead and the height
  const h = n.unpitched.octave * 7 + 'CDEFGAB'.indexOf(n.unpitched.step);
  if (head && /x/.test(head)) return h >= 5 * 7 + 5 ? 'crash' : h >= 5 * 7 + 3 ? 'ride' : 'hat';
  if (h <= 4 * 7 + 3) return 'kick';
  if (h < 5 * 7) return 'tom-l';
  if (h === 5 * 7) return 'snare';
  return 'tom-h';
}
