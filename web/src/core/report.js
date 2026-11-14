// The practice report after Play Along, worked out from a take's result (pure code; screens/report.jsx draws it).
// Overview: score, stars, intonation, rhythm and how steady the playing was across bars; details: every bar and
// every note that went wrong; the trend over earlier takes of the same piece; three concrete recommendations and
// a next exercise (a scale in the piece's key, at a speed that suits the take).

export function stars(acc) { return acc >= 0.95 ? 3 : acc >= 0.8 ? 2 : acc >= 0.55 ? 1 : 0; }

/** Steadiness from bar to bar: 1 = every bar as good as the others, lower = some bars fall apart. */
export function stability(bars) {
  if (!bars?.length) return null;
  const xs = bars.map((b) => b.accuracy);
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
  return Math.max(0, Math.min(1, 1 - sd * 1.6));
}

/** Earlier takes of this piece, oldest first, with this one at the end: [{date, accuracy}]. */
export function trend(history, pieceId, now = null) {
  const xs = (history || []).filter((h) => h.pieceId === pieceId && typeof h.accuracy === 'number').sort((a, b) => a.date - b.date).map((h) => ({ date: h.date, accuracy: h.accuracy }));
  if (now) xs.push(now);
  return xs.slice(-12);
}

/**
 * Three recommendations, most useful first, as {key, vars} for the interface text, plus the bars they are about.
 */
export function recommendations(result) {
  const out = [];
  const acc = result.accuracy ?? 0;
  const speed = result.speed ?? 1;
  const tricky = result.tricky || [];
  const wrong = result.wrong || [];
  if (tricky[0]) out.push({ key: 'recLoopBar', vars: { bar: tricky[0].bar ?? tricky[0].mi + 1, speed: Math.max(40, Math.round(speed * 100) - 20) }, bars: [tricky[0].mi] });
  // the same wrong note again and again: a fingering/key-signature slip
  const counts = new Map();
  for (const w of wrong) if (w.played && w.played !== w.want) { const k = `${w.want}>${w.played}`; counts.set(k, (counts.get(k) || 0) + 1); }
  const [rep] = [...counts].sort((a, b) => b[1] - a[1]);
  if (rep && rep[1] >= 2) { const [want, played] = rep[0].split('>'); out.push({ key: 'recSameSlip', vars: { want, played, n: rep[1] } }); }
  if (result.mode === 'beat' && result.inTune !== undefined && result.inTune < 0.8) out.push({ key: 'recIntonation', vars: { n: Math.round(result.inTune * 100) } });
  const st = stability(result.barsList);
  if (st !== null && st < 0.7 && acc >= 0.6) out.push({ key: 'recSteady', vars: {} });
  if (acc >= 0.92) out.push({ key: speed < 1 ? 'recFaster' : 'recNextPiece', vars: { speed: Math.min(150, Math.round(speed * 100) + 10) } });
  else if (acc < 0.55) out.push({ key: 'recSlower', vars: { speed: Math.max(40, Math.round(speed * 100) - 25) } });
  out.push({ key: 'recDaily', vars: { min: acc >= 0.8 ? 10 : 15 } });
  const seen = new Set();
  return out.filter((r) => (seen.has(r.key) ? false : seen.add(r.key))).slice(0, 3);
}

/** A scale exercise to do next: in the piece's key, slower when the take was hard. */
export function nextExercise(result, key) {
  const fifths = key?.fifths ?? 0;
  const minor = key?.mode === 'minor';
  const tonicNames = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
  const relMinor = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];
  const tonic = (minor ? relMinor : tonicNames)[fifths + 7] || 'C';
  const acc = result.accuracy ?? 0;
  return { tonic, type: minor ? 'harmonic minor' : 'major', octaves: acc >= 0.85 ? 2 : 1, speed: acc >= 0.85 ? 100 : 70 };
}

export function buildReport(result, { history = [], pieceId = null, key = null } = {}) {
  const acc = result.accuracy ?? 0;
  const bars = (result.barsList || []).map((b) => ({ ...b, pct: Math.round(b.accuracy * 100) }));
  return {
    overview: {
      accuracy: Math.round(acc * 100), stars: stars(acc), right: result.right, total: result.total,
      intonation: result.inTune !== undefined ? Math.round(result.inTune * 100) : null,
      rhythm: result.mode === 'beat' && result.timing !== undefined ? Math.round(result.timing * 100) : null,
      stability: stability(result.barsList) === null ? null : Math.round(stability(result.barsList) * 100),
      speed: Math.round((result.speed ?? 1) * 100),
    },
    bars,
    worstBars: [...bars].sort((a, b) => a.accuracy - b.accuracy).slice(0, 3).filter((b) => b.accuracy < 0.9),
    notes: result.wrong || [],
    trend: trend(history, pieceId, { date: Date.now(), accuracy: acc }),
    recommendations: recommendations(result),
    next: nextExercise(result, key),
  };
}

/** The report as plain text (shared as a message, or with a teacher). */
export function reportText(r, title, tr = (k, v) => `${k} ${JSON.stringify(v || {})}`) {
  const lines = [`${title}: ${r.overview.accuracy}% (${r.overview.right}/${r.overview.total}) ${'★'.repeat(r.overview.stars)}`];
  if (r.worstBars.length) lines.push(r.worstBars.map((b) => `${tr('bar', { n: b.bar })} ${b.pct}%`).join(', '));
  for (const x of r.recommendations) lines.push(`• ${tr(x.key, x.vars)}`);
  return lines.join('\n');
}
