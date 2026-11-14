// The microphone's own little audio graph, kept apart so a test can prove it never reaches the speakers.
//   microphone -> high-pass 70 Hz (rumble, traffic, handling noise) -> analyser
// Safari only runs an analyser that leads somewhere, so there (and only there) the analyser feeds a gain of
// exactly 0 that goes to the output. Chrome and Android need no such path: there the graph has no route to the
// speakers at all, so the microphone can never be heard and never feed back into itself.

export const needsKeepAlive = (ua = globalThis.navigator?.userAgent || '') => /iPhone|iPad|iPod|Macintosh/.test(ua) && /AppleWebKit/.test(ua) && !/Chrome|CriOS|Android/.test(ua);

/** Builds the graph on `actx` for `stream`. Returns {src, hp, an, sink, disconnect}. */
export function buildMicGraph(actx, stream, { keepAlive = needsKeepAlive(), fftSize = 2048 } = {}) {
  const src = actx.createMediaStreamSource(stream);
  const hp = actx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 70; hp.Q.value = 0.7;
  const an = actx.createAnalyser();
  an.fftSize = fftSize;
  an.smoothingTimeConstant = 0;
  src.connect(hp);
  hp.connect(an);
  let sink = null;
  if (keepAlive) {
    sink = actx.createGain();
    sink.gain.value = 0;
    an.connect(sink);
    sink.connect(actx.destination);
  }
  const disconnect = () => { for (const n of [src, hp, an, sink]) { try { n?.disconnect(); } catch { /* gone */ } } };
  return { src, hp, an, sink, disconnect };
}

/**
 * True when sound from `from` can reach `ctx.destination` through nodes that pass it (a gain node whose gain is 0
 * passes nothing). Works on any graph whose nodes record their outputs in `node.outputs` (the test's fake), or
 * on a list of [from, to] edges.
 */
export function reachesOutput(from, destination) {
  const seen = new Set();
  const walk = (n) => {
    if (n === destination) return true;
    if (!n || seen.has(n)) return false;
    seen.add(n);
    if (n.kind === 'gain' && n.gain && n.gain.value === 0) return false;
    return (n.outputs || []).some(walk);
  };
  return walk(from);
}
