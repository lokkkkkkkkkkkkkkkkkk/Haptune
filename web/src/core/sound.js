// Sounds: short multitrack pieces anyone can make and post on Stage (a hummed melody, a riff, a chord idea, a
// practice take with backing, a remix of a sheet). This is the mixer's model and the sample maths, with no
// browser APIs: tracks and their settings, solo/mute, quantize, time-stretch, the length of the piece, the
// WAV writer, and MIDI from instrument tracks. ui/soundengine.js plays and renders it; screens/sound.jsx edits it.

export const MAX_TRACKS = 8;
export const TRACK_KINDS = ['mic', 'instrument', 'audio', 'backing', 'take', 'stem'];
let seq = 0;
const tid = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;
const clone = (x) => JSON.parse(JSON.stringify(x));

export function newSound({ title = '', tempo = 90, key = { fifths: 0, mode: 'major' }, time = { beats: 4, beatType: 4 }, bars = 8 } = {}) {
  return { v: 1, id: `s${Date.now().toString(36)}`, title, tempo, key, time, bars, metronome: true, countIn: true, master: { volume: 0.9, limiter: true }, tracks: [], parent: null, credits: [] };
}

export function newTrack(kind, patch = {}) {
  if (!TRACK_KINDS.includes(kind)) throw new Error(`unknown track kind ${kind}`);
  return {
    id: tid(), kind, name: patch.name || kind, volume: 0.8, pan: 0, mute: false, solo: false, gain: 1,
    eqLow: 0, eqHigh: 0, reverb: kind === 'mic' ? 0.15 : 0.1, fadeIn: 0, fadeOut: 0,
    offset: 0,                   // seconds from the start of the Sound where the clip begins
    trim: { start: 0, end: null }, // seconds of the clip that are heard
    loop: null,                  // {start, end} in seconds of the clip, repeated to the end of the Sound
    stretch: 1,                  // playback length factor (time-stretch to match a new tempo, pitch kept)
    clip: null,                  // audio: {id, seconds, sampleRate}
    notes: [],                   // instrument: [{t, dur (beats), midi, vel}]
    instrument: 'piano',
    song: null,                  // backing: a chord song (core/chordbars.js) and its style
    ...patch,
  };
}

const edit = (s, fn) => { const out = clone(s); fn(out); return out; };
export function addTrack(sound, track) {
  if (sound.tracks.length >= MAX_TRACKS) throw new Error(`A Sound has at most ${MAX_TRACKS} tracks.`);
  return edit(sound, (o) => { o.tracks.push(track); });
}
export function updateTrack(sound, id, patch) {
  return edit(sound, (o) => { const t = o.tracks.find((x) => x.id === id); if (t) Object.assign(t, typeof patch === 'function' ? patch(t) : patch); });
}
export function removeTrack(sound, id) { return edit(sound, (o) => { o.tracks = o.tracks.filter((x) => x.id !== id); }); }
export function setSound(sound, patch) { return edit(sound, (o) => Object.assign(o, patch)); }

/** The tracks you hear: with any track soloed, only the soloed ones; muted ones never. */
export function audible(sound) {
  const solo = sound.tracks.some((t) => t.solo);
  return sound.tracks.filter((t) => !t.mute && (!solo || t.solo));
}

export const secondsPerBeat = (sound) => 60 / (sound.tempo || 90) * (4 / (sound.time?.beatType || 4));
export const barSeconds = (sound) => secondsPerBeat(sound) * (sound.time?.beats || 4);

/** How long a track sounds (seconds), from its start in the Sound. */
export function trackSeconds(sound, t) {
  if (t.kind === 'instrument') return t.notes.reduce((m, n) => Math.max(m, (n.t + n.dur) * secondsPerBeat(sound)), 0);
  if (t.kind === 'backing') return sound.bars * barSeconds(sound);
  if (!t.clip) return 0;
  if (t.loop) return Math.max(0, sound.bars * barSeconds(sound) - t.offset);
  const end = t.trim.end ?? t.clip.seconds;
  return Math.max(0, (end - t.trim.start) * (t.stretch || 1));
}

/** The Sound's length: whole bars, long enough for every track. */
export function soundSeconds(sound) {
  const longest = sound.tracks.reduce((m, t) => Math.max(m, t.offset + trackSeconds(sound, t)), 0);
  const bars = Math.max(sound.bars || 1, Math.ceil(longest / barSeconds(sound) - 1e-6));
  return bars * barSeconds(sound);
}

/** Notes moved to the nearest grid line (grid in beats: 1 = quarter notes, 0.5 = eighths, 1/3 = triplets). */
export function quantize(notes, grid = 0.5, strength = 1) {
  return notes.map((n) => {
    const q = Math.round(n.t / grid) * grid;
    const t = n.t + (q - n.t) * strength;
    const end = n.t + n.dur;
    const qe = Math.max(q + grid, Math.round(end / grid) * grid);
    return { ...n, t: Math.max(0, t), dur: Math.max(grid / 2, (end + (qe - end) * strength) - Math.max(0, t)) };
  });
}

/** A new tempo: instrument notes keep their beats; audio clips are stretched (pitch kept) to stay in time. */
export function changeTempo(sound, tempo) {
  const ratio = (sound.tempo || 90) / tempo;
  return edit(sound, (o) => {
    o.tempo = tempo;
    for (const t of o.tracks) {
      if (t.clip && (t.kind === 'mic' || t.kind === 'audio' || t.kind === 'take' || t.kind === 'stem')) { t.stretch = (t.stretch || 1) * ratio; t.offset *= ratio; }
    }
  });
}

/**
 * Time-stretch without changing pitch (overlap-add with a similarity search, WSOLA): `factor` > 1 makes it longer.
 * Good enough for voice and solo instruments over a few percent to about ±30 %.
 */
export function timeStretch(input, factor, { size = 1024 } = {}) {
  if (Math.abs(factor - 1) < 1e-3) return Float32Array.from(input);
  const hopOut = size / 2, hopIn = hopOut / factor, search = Math.floor(size / 4);
  const win = Float32Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  const outLen = Math.floor(input.length * factor);
  const out = new Float32Array(outLen + size), norm = new Float32Array(outLen + size);
  let prev = 0;
  for (let k = 0, o = 0; o < outLen; k++, o += hopOut) {
    let pos = Math.round(k * hopIn);
    if (k > 0) {                                   // find the start that continues the previous frame best
      let best = pos, bestC = -Infinity;
      const nat = prev + hopOut;
      for (let d = -search; d <= search; d += 4) {
        const p = pos + d;
        if (p < 0 || p + size > input.length) continue;
        let c = 0;
        for (let i = 0; i < hopOut; i += 4) c += input[p + i] * (input[nat + i] || 0);
        if (c > bestC) { bestC = c; best = p; }
      }
      pos = best;
    }
    if (pos + size > input.length) break;
    for (let i = 0; i < size; i++) { out[o + i] += input[pos + i] * win[i]; norm[o + i] += win[i]; }
    prev = pos;
  }
  const res = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) res[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
  return res;
}

/** 16-bit PCM WAV from channels (Float32Array each, -1..1). */
export function encodeWav(channels, sampleRate) {
  const n = channels[0].length, ch = channels.length;
  const buf = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const x = Math.max(-1, Math.min(1, channels[c][i])); v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true); o += 2; }
  return new Uint8Array(buf);
}

/** Reads a 16-bit PCM WAV back (for tests and re-imports): {sampleRate, channels}. */
export function decodeWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ch = v.getUint16(22, true), sr = v.getUint32(24, true), len = v.getUint32(40, true) / 2 / ch;
  const channels = Array.from({ length: ch }, () => new Float32Array(len));
  for (let i = 0, o = 44; i < len; i++) for (let c = 0; c < ch; c++, o += 2) channels[c][i] = v.getInt16(o, true) / 0x8000;
  return { sampleRate: sr, channels };
}

/** Instrument tracks as a type-1 MIDI file (one MIDI track each). */
export function soundToMidi(sound) {
  const PPQ = 480;
  const vlq = (x) => { const b = [x & 0x7f]; while ((x >>= 7)) b.unshift((x & 0x7f) | 0x80); return b; };
  const tracks = [];
  const tempoUs = Math.round(60000000 / (sound.tempo || 90));
  tracks.push([0, 0xff, 0x51, 3, (tempoUs >> 16) & 255, (tempoUs >> 8) & 255, tempoUs & 255, 0, 0xff, 0x2f, 0]);
  sound.tracks.filter((t) => t.kind === 'instrument' && t.notes.length).forEach((t, k) => {
    const chn = k % 16 === 9 ? 10 : k % 16;
    const ev = [];
    for (const n of t.notes) { ev.push([Math.round(n.t * PPQ), 0x90 | chn, n.midi, n.vel || 90]); ev.push([Math.round((n.t + n.dur) * PPQ), 0x80 | chn, n.midi, 0]); }
    ev.sort((a, b) => a[0] - b[0] || (a[1] & 0xf0) - (b[1] & 0xf0));
    const bytes = [];
    let last = 0;
    for (const [tk, st, d1, d2] of ev) { bytes.push(...vlq(tk - last), st, d1, d2); last = tk; }
    bytes.push(0, 0xff, 0x2f, 0);
    tracks.push(bytes);
  });
  const out = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255];
  for (const tr of tracks) out.push(0x4d, 0x54, 0x72, 0x6b, (tr.length >>> 24) & 255, (tr.length >> 16) & 255, (tr.length >> 8) & 255, tr.length & 255, ...tr);
  return new Uint8Array(out);
}

/** Peaks for drawing a waveform: n pairs of [min, max]. */
export function peaks(samples, n = 200) {
  const out = [];
  const step = Math.max(1, Math.floor(samples.length / n));
  for (let i = 0; i < samples.length && out.length < n; i += step) {
    let lo = 0, hi = 0;
    for (let j = i; j < Math.min(samples.length, i + step); j++) { if (samples[j] < lo) lo = samples[j]; if (samples[j] > hi) hi = samples[j]; }
    out.push([lo, hi]);
  }
  return out;
}

/** A Sound ready to post: the project without audio (clips are uploaded as one mixdown) and what it credits. */
export function projectForPost(sound) {
  const s = clone(sound);
  for (const t of s.tracks) if (t.clip) t.clip = { seconds: t.clip.seconds, sampleRate: t.clip.sampleRate };
  return s;
}

/** Layer with me: a new Sound on top of someone's public Sound (their mixdown is track 1), with credit. */
export function layerOn(parent, { mixdownClipId, seconds, sampleRate, author }) {
  const s = newSound({ title: `${parent.title} (layer)`, tempo: parent.tempo, key: parent.key, time: parent.time, bars: parent.bars });
  s.parent = parent.post_id || parent.id;
  s.credits = [...(parent.credits || []), ...(author ? [author] : [])];
  return addTrack(s, newTrack('audio', { name: parent.title || 'Original', clip: { id: mixdownClipId, seconds, sampleRate }, volume: 0.85 }));
}

export const history = {
  start: (now) => ({ past: [], now, future: [] }),
  push: (h, next) => (next === h.now ? h : { past: [...h.past.slice(-79), h.now], now: next, future: [] }),
  undo: (h) => (h.past.length ? { past: h.past.slice(0, -1), now: h.past[h.past.length - 1], future: [h.now, ...h.future] } : h),
  redo: (h) => (h.future.length ? { past: [...h.past, h.now], now: h.future[0], future: h.future.slice(1) } : h),
};
