/** User prefs for Smart TV / desktop (seek, autoplay, onboarding, UI size). */

const KEY = 'swiftstv.prefs.v1';

const DEFAULTS = {
  seekJump: 30, // seconds: 10 | 30 | 60
  autoplayNext: true,
  onboardingDone: false,
  uiScale: 'comfortable', // comfortable | normal | compact — TV-first default
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function getPrefs() {
  return read();
}

export function setPrefs(patch) {
  const next = { ...read(), ...patch };
  if (![10, 30, 60].includes(Number(next.seekJump))) next.seekJump = 30;
  if (!['comfortable', 'normal', 'compact'].includes(next.uiScale)) next.uiScale = 'normal';
  write(next);
  applyUiScale(next.uiScale);
  return next;
}

export function applyUiScale(scale) {
  const s = scale || getPrefs().uiScale || 'normal';
  try {
    document.documentElement.dataset.uiScale = s;
  } catch {
    /* ignore */
  }
}
