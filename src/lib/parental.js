import { isAdultCategory, isAdultTitle } from './adult.js';

// Parental gate by PIN. Two layers:
//  1) Optional profile + blocked category_ids (Settings / Control parental screen).
//  2) Adult content PIN (Android ParentalGate parity): ALWAYS required to open
//     adult/XXX categories or play adult titles. First visit creates a 4-digit
//     PIN; master unlock is 0000 (never shown in UI — support only).

const KEYS = {
  profiles: 'swiftstv.parental.profiles.v1',
  active: 'swiftstv.parental.active.v1',
  adultPin: 'swiftstv.parentalPin.v1',
};

/** Internal only — never surface in Settings / dialogs. */
export const MASTER_PIN = '0000';

export const PinResult = {
  Ok: 'Ok',
  Created: 'Created',
  MasterUnlock: 'MasterUnlock',
  Invalid: 'Invalid',
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota / privacy mode — best effort.
  }
}

// ---- Adult PIN (required for XXX) ------------------------------------------

export function getAdultPin() {
  const v = read(KEYS.adultPin, null);
  if (v == null || v === '') return null;
  return String(v);
}

export function saveAdultPin(pin) {
  write(KEYS.adultPin, String(pin || ''));
}

export function clearAdultPin() {
  try {
    localStorage.removeItem(KEYS.adultPin);
  } catch {}
}

export function hasAdultPin() {
  return Boolean(getAdultPin());
}

/**
 * Verify PIN for adult unlock — parity with Android ParentalGate.verify.
 * - 0000 → MasterUnlock (clears saved PIN)
 * - no saved PIN + 4 digits → Created (save it)
 * - matches saved → Ok
 */
export function verifyAdultPin(input) {
  const pin = String(input || '');
  if (pin === MASTER_PIN) return PinResult.MasterUnlock;
  const saved = getAdultPin();
  if (!saved) {
    return pin.length === 4 && /^\d{4}$/.test(pin) ? PinResult.Created : PinResult.Invalid;
  }
  return pin === saved ? PinResult.Ok : PinResult.Invalid;
}

/** Apply verify result (save / clear). Returns true when access should be granted. */
export function applyAdultPinResult(result, input) {
  if (result === PinResult.Created) {
    saveAdultPin(input);
    return true;
  }
  if (result === PinResult.Ok) return true;
  if (result === PinResult.MasterUnlock) {
    clearAdultPin();
    return true;
  }
  return false;
}

export function needsAdultGate(title, categoryName = '') {
  return isAdultTitle(title) || isAdultCategory(categoryName);
}

// ---- Adult browse unlock (session) -----------------------------------------
// PIN once when opening an adult category. Stay unlocked while that category is
// selected (incl. leaving to Player and back). Clear when the user picks another
// category — opening adult again asks for PIN.
const ADULT_UNLOCK_KEY = 'swiftstv.adultUnlockedCat.v1';

export function unlockAdultBrowse(categoryId) {
  try {
    sessionStorage.setItem(ADULT_UNLOCK_KEY, String(categoryId ?? ''));
  } catch {
    /* ignore */
  }
}

export function clearAdultBrowseUnlock() {
  try {
    sessionStorage.removeItem(ADULT_UNLOCK_KEY);
  } catch {
    /* ignore */
  }
}

export function getAdultBrowseUnlock() {
  try {
    return sessionStorage.getItem(ADULT_UNLOCK_KEY);
  } catch {
    return null;
  }
}

/** True when this adult category was unlocked with PIN this session. */
export function isAdultBrowseUnlocked(categoryId) {
  const u = getAdultBrowseUnlock();
  if (u == null) return false;
  return String(u) === String(categoryId ?? '');
}

/** Any adult category currently unlocked (for detail play after grid unlock). */
export function hasAdultBrowseUnlock() {
  return getAdultBrowseUnlock() != null;
}

// ---- Profile / blocked categories (optional Settings UI) -------------------

export function getParentalState() {
  return read(KEYS.profiles, { profiles: [], active: '' });
}

export function saveParentalState(state) {
  write(KEYS.profiles, {
    profiles: Array.isArray(state?.profiles) ? state.profiles : [],
    active: String(state?.active || ''),
  });
}

export function getActiveProfile() {
  const state = getParentalState();
  if (!state.active) return null;
  return state.profiles.find((p) => p.id === state.active) || null;
}

export function isCategoryLocked(categoryId) {
  const profile = getActiveProfile();
  if (!profile) return false;
  const blocked = Array.isArray(profile.blockedCategoryIds) ? profile.blockedCategoryIds : [];
  return blocked.some((cid) => String(cid) === String(categoryId));
}

export function isParentalEnabled() {
  return Boolean(getActiveProfile()?.pin);
}

export function upsertProfile(profile) {
  const state = getParentalState();
  const idx = state.profiles.findIndex((p) => p.id === profile.id);
  const normalized = {
    id: profile.id,
    name: profile.name || 'Perfil',
    pin: String(profile.pin || ''),
    blockedCategoryIds: Array.isArray(profile.blockedCategoryIds)
      ? profile.blockedCategoryIds.map(String)
      : [],
  };
  if (idx >= 0) state.profiles[idx] = normalized;
  else state.profiles.push(normalized);
  if (!state.active && normalized.pin) state.active = normalized.id;
  saveParentalState(state);
  return state;
}

export function deleteProfile(id) {
  const state = getParentalState();
  state.profiles = (state.profiles || []).filter((p) => p.id !== id);
  if (state.active === id) state.active = '';
  saveParentalState(state);
  return state;
}

export function setActiveProfile(id) {
  const state = getParentalState();
  state.active = String(id || '');
  saveParentalState(state);
  return state;
}

export function verifyPin(pin) {
  const profile = getActiveProfile();
  return Boolean(profile && profile.pin && String(profile.pin) === String(pin));
}
