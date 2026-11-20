// The ripple when something is tapped (like Material Design's): a soft circle grows from the finger and fades.
// One listener for the whole app; nothing for reduced motion. The press itself (scale) is CSS (v6.css).
const SEL = '.btn, .row, .hero-tile, .browse-tile, .sum-tile, .gm-card, .art-card, .wiz-card, .wiz-chip, .side button, .tabbar button, .shelf-item, .quick-start, .help-tour, .g-btn, .coach-next';

export function installPress(root = globalThis.document) {
  if (!root?.addEventListener) return;
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  root.addEventListener('pointerdown', (e) => {
    if (still?.matches || e.button > 0) return;
    const el = e.target.closest?.(SEL);
    if (!el || el.disabled || el.closest('.no-rip')) return;
    const cs = getComputedStyle(el);
    if (cs.position === 'static') el.style.position = 'relative';
    const r = el.getBoundingClientRect();
    const size = Math.hypot(Math.max(e.clientX - r.left, r.right - e.clientX), Math.max(e.clientY - r.top, r.bottom - e.clientY)) * 2;
    const wrap = document.createElement('span');
    wrap.className = 'rip-wrap';
    const dot = document.createElement('span');
    dot.className = 'rip';
    dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    wrap.appendChild(dot);
    el.appendChild(wrap);
    setTimeout(() => wrap.remove(), 650);
  }, { passive: true, capture: true });
}
