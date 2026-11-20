// Hapi, Haptune's mascot: a round eighth note with a face. Pure SVG + CSS animation (no images), so it is
// tiny, sharp at any size and follows reduced-motion settings.
//   mood: happy | cheer | think | listen | sleep | wave | sad
let uid = 0;

export function Mascot({ mood = 'happy', size = 96, animate = true, label, class: cls = '' }) {
  const id = `hapi${++uid}`;
  const eyesClosed = mood === 'sleep' || mood === 'listen';
  const look = mood === 'think' ? { x: -1.6, y: -2.2 } : { x: 0.8, y: 0.6 };
  return (
    <svg class={`mascot m-${mood}${animate ? ' anim' : ''} ${cls}`} width={size} height={size} viewBox="0 0 120 120"
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : 'true'}>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#7B6CFF" />
          <stop offset="0.55" stop-color="#B455F2" />
          <stop offset="1" stop-color="#FF6FA8" />
        </linearGradient>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9A7BFF" />
          <stop offset="1" stop-color="#7B5CF0" />
        </linearGradient>
        <radialGradient id={`${id}h`} cx="0.35" cy="0.3" r="0.6">
          <stop offset="0" stop-color="#fff" stop-opacity="0.55" />
          <stop offset="1" stop-color="#fff" stop-opacity="0" />
        </radialGradient>
      </defs>
      <ellipse class="shadow" cx="54" cy="112" rx="30" ry="4.5" fill="#000" opacity="0.10" />
      <g class="body">
        {/* stem and flag: the "hair" */}
        <rect x="80" y="14" width="8" height="62" rx="4" fill={`url(#${id}s)`} />
        <path class="flag" d="M86 16c14 5 22 15 17 30-1-9-7-15-17-17z" fill={`url(#${id}s)`} />
        {mood === 'listen' && <path d="M22 62a32 32 0 0 1 62-8" fill="none" stroke="#2E2A4F" stroke-width="5" stroke-linecap="round" />}
        {mood === 'listen' && <rect x="14" y="58" width="12" height="18" rx="6" fill="#2E2A4F" />}
        {/* arms */}
        {(mood === 'cheer' || mood === 'wave') && <path class="arm-r" d="M84 70c8-4 12-12 12-20" fill="none" stroke="#B455F2" stroke-width="7" stroke-linecap="round" />}
        {mood === 'cheer' && <path class="arm-l" d="M22 76c-8-4-12-12-12-20" fill="none" stroke="#7B6CFF" stroke-width="7" stroke-linecap="round" />}
        {/* head = note head */}
        <ellipse cx="52" cy="76" rx="35" ry="30" transform="rotate(-14 52 76)" fill={`url(#${id}g)`} />
        <ellipse cx="52" cy="76" rx="35" ry="30" transform="rotate(-14 52 76)" fill={`url(#${id}h)`} />
        {/* cheeks */}
        <ellipse cx="31" cy="85" rx="6" ry="4" fill="#FF8FB8" opacity="0.7" />
        <ellipse cx="72" cy="79" rx="6" ry="4" fill="#FF8FB8" opacity="0.7" />
        {/* eyes */}
        {eyesClosed ? (
          <g fill="none" stroke="#2E2A4F" stroke-width="3.4" stroke-linecap="round">
            <path d={mood === 'sleep' ? 'M33 73h10' : 'M33 74q5-6 10 0'} />
            <path d={mood === 'sleep' ? 'M56 69h10' : 'M56 70q5-6 10 0'} />
          </g>
        ) : (
          <g class="eyes">
            <ellipse cx="38" cy="72" rx="8" ry="9.5" fill="#fff" />
            <ellipse cx="61" cy="67" rx="8" ry="9.5" fill="#fff" />
            <circle cx={38 + look.x} cy={73 + look.y} r="4.6" fill="#2E2A4F" />
            <circle cx={61 + look.x} cy={68 + look.y} r="4.6" fill="#2E2A4F" />
            <circle cx={36.5 + look.x} cy={71 + look.y} r="1.6" fill="#fff" />
            <circle cx={59.5 + look.x} cy={66 + look.y} r="1.6" fill="#fff" />
          </g>
        )}
        {/* mouth */}
        {mood === 'cheer' ? <path d="M42 86q9 11 18-2z" fill="#2E2A4F" />
          : mood === 'think' ? <circle cx="52" cy="88" r="3" fill="#2E2A4F" />
            : mood === 'sad' ? <path d="M43 91q8-6 16 0" fill="none" stroke="#2E2A4F" stroke-width="3" stroke-linecap="round" />
              : mood === 'sleep' ? <ellipse cx="51" cy="88" rx="3" ry="2" fill="#2E2A4F" />
                : <path d="M43 86q8 8 16-1" fill="none" stroke="#2E2A4F" stroke-width="3.2" stroke-linecap="round" />}
      </g>
      {mood === 'sleep' && <text class="zz" x="88" y="56" font-size="16" font-weight="800" fill="#7B6CFF">z</text>}
      {mood === 'think' && <g class="dots" fill="#7B6CFF"><circle cx="96" cy="58" r="3" /><circle cx="104" cy="50" r="4" /><circle cx="112" cy="40" r="5" /></g>}
      {mood === 'cheer' && <g class="sparks" fill="#FFC53D"><path d="M14 30l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" /><path d="M104 74l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" /></g>}
    </svg>
  );
}

/** A short burst of confetti for a win (removes itself). */
export function Confetti({ count = 26 }) {
  const colors = ['#7B6CFF', '#FF6FA8', '#FFC53D', '#34C759', '#32ADE6', '#FF9500'];
  return (
    <div class="confetti" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <i key={i} style={{ '--x': `${(i * 37) % 100}%`, '--d': `${(i % 7) * 0.06}s`, '--r': `${(i * 53) % 360}deg`, background: colors[i % colors.length] }} />
      ))}
    </div>
  );
}

/** The soft, slowly moving colour background behind the whole app. The palette follows the open tab. */
export function Aurora({ tab }) {
  return (
    <div class={`aurora a-${tab}`} aria-hidden="true">
      <i class="b1" /><i class="b2" /><i class="b3" /><i class="b4" />
    </div>
  );
}
