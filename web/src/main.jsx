import { mount } from './ui/app.jsx';

mount();
if ('serviceWorker' in navigator && globalThis.HAPTUNE_CONFIG?.pwa && location.protocol === 'https:') {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
