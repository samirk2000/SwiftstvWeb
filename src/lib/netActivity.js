// Tiny activity bus for panel downloads so the UI can say what it's doing
// ("Descargando canales… 40%" / "Preparando catálogo… 35%") and so background
// work (search index) yields to whatever the user is waiting for.
const fg = new Map(); // id -> { kind, loaded, total }
let bg = null; // { part, done, total } | null
let lastFgEnd = 0;
let seq = 0;
const listeners = new Set();
let notifyQueued = false;

function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  const run = () => {
    notifyQueued = false;
    const snap = snapshot();
    listeners.forEach((fn) => {
      try {
        fn(snap);
      } catch {
        /* ignore */
      }
    });
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

export function snapshot() {
  const list = [...fg.values()].map((v) => ({ ...v }));
  return { fgList: list, fgCount: fg.size, bg: bg ? { ...bg } : null };
}

export function subscribeActivity(fn) {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

/** Foreground panel request (the user is waiting). Returns { progress, end }. */
export function beginForeground(kind = 'catalog') {
  seq += 1;
  const id = seq;
  // Remember which screen asked, so a leftover request from the previous
  // screen isn't announced on the new one.
  const route = typeof location !== 'undefined' ? location.pathname : '';
  fg.set(id, { kind, loaded: 0, total: 0, route });
  notify();
  return {
    progress(loaded, total) {
      const e = fg.get(id);
      if (!e) return;
      e.loaded = loaded;
      e.total = total || 0;
      notify();
    },
    end() {
      if (!fg.delete(id)) return;
      lastFgEnd = Date.now();
      notify();
    },
  };
}

export function foregroundBusy(quietMs = 2500) {
  return fg.size > 0 || Date.now() - lastFgEnd < quietMs;
}

export function setBackgroundProgress(state) {
  bg = state;
  notify();
}

/** Resolve once nothing in the foreground has run for `quietMs`. */
export function waitForegroundQuiet(quietMs = 2500) {
  return new Promise((resolve) => {
    const check = () => (foregroundBusy(quietMs) ? setTimeout(check, 700) : resolve());
    check();
  });
}

/** Map an Xtream action to a label kind. */
export function kindForAction(action) {
  const a = String(action || '');
  if (a.startsWith('get_live')) return 'live';
  if (a.startsWith('get_vod')) return 'vod';
  if (a.startsWith('get_series')) return 'series';
  if (a === 'get_short_epg' || a === 'get_simple_data_table') return 'epg';
  return 'catalog';
}
