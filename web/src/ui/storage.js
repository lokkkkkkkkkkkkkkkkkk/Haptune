// On-device storage: IndexedDB for the library (MusicXML, chord sheets, PDFs), localStorage for small
// settings. Falls back to memory when the browser blocks storage (private windows, previews).
const DB_NAME = 'haptune';
const STORES = { pieces: 'id', history: 'id', kv: 'k' };
let dbPromise = null;
let memoryOnly = false;
const mem = { pieces: new Map(), history: new Map(), kv: new Map() };

function openDb() {
  if (memoryOnly) return Promise.reject(new Error('memory'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const [name, keyPath] of Object.entries(STORES)) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
        setTimeout(() => reject(new Error('timeout')), 4000);
      } catch (e) { reject(e); }
    }).catch((e) => { memoryOnly = true; throw e; });
  }
  return dbPromise;
}

async function run(store, mode, op) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = op(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    memoryOnly = true;
    return null;
  }
}

export const db = {
  get isMemory() { return memoryOnly; },
  async all(store) {
    const r = await run(store, 'readonly', (s) => s.getAll());
    return memoryOnly ? [...mem[store].values()] : r || [];
  },
  async get(store, key) {
    const r = await run(store, 'readonly', (s) => s.get(key));
    return memoryOnly ? mem[store].get(key) : r;
  },
  async put(store, obj) {
    mem[store].set(obj[STORES[store]], obj);
    if (!memoryOnly) await run(store, 'readwrite', (s) => s.put(obj));
    return obj;
  },
  async del(store, key) {
    mem[store].delete(key);
    if (!memoryOnly) await run(store, 'readwrite', (s) => s.delete(key));
  },
  async clear() {
    for (const s of Object.keys(STORES)) { mem[s].clear(); if (!memoryOnly) await run(s, 'readwrite', (st) => st.clear()); }
  },
};

export const local = {
  get(k, fallback) {
    try { const v = localStorage.getItem('haptune.' + k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem('haptune.' + k, JSON.stringify(v)); } catch { /* storage blocked */ }
  },
  clear() {
    try { Object.keys(localStorage).filter((k) => k.startsWith('haptune.')).forEach((k) => localStorage.removeItem(k)); } catch { /* blocked */ }
  },
};
