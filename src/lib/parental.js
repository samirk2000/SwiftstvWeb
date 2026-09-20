import { isAdultCategory, isAdultTitle } from './adult.js';
import { activeAccountId } from './session.js';

// Parental gate by PIN. Two layers:
//  1) Optional profile + blocked category_ids (Settings / Control parental screen).
//  2) Adult content PIN (Android ParentalGate parity): ALWAYS required to open
//     adult/XXX categories or play adult titles. First visit creates a 4-digit
//     PIN; master unlock is 0000 (never shown in UI — support only).
//
// All of the above is scoped per Xtream account so switching users never
// reuses another account's PIN / blocked categories.

const KEYS = {
  profiles: 'swiftstv.parental.profiles.v2',
  profilesLegacy: 'swiftstv.parental.profiles.v1',
  adultPin: 'swiftstv.parentalPin.v2',
  adultPinLegacy: 'swiftstv.parentalPin.v1',
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

function accountKey() {
  return activeAccountId() || '';
}

function readAccountMap(key, legacyKey) {
  let store = read(key, null);
  if (!store || typeof store !== 'object' || Array.isArray(store)) store = {};

  if (legacyKey) {
    const legacy = read(legacyKey, null);
    if (legacy != null && legacy !== '') {
      const aid = accountKey();
      if (aid && store[aid] == null) {
        store = { ...store, [aid]: legacy };
        write(key, store);
      }
      try {
        localStorage.removeItem(legacyKey);
      } catch {
        /* ignore */
      }
    }
  }
  return store;
}

function getAccountValue(key, legacyKey, fallback) {
  const aid = accountKey();
  if (!aid) return fallback;
  const store = readAccountMap(key, legacyKey);
  return store[aid] !== undefined ? store[aid] : fallback;
}

function setAccountValue(key, value) {
  const aid = accountKey();
  if (!aid) return;
  const store = readAccountMap(key);
  write(key, { ...store, [aid]: value });
}

function clearAccountValue(key) {
  const aid = accountKey();
  if (!aid) return;
  const store = readAccountMap(key);
  if (store[aid] === undefined) return;
  const next = { ...store };
  delete next[aid];
  write(key, next);
}

/** Drop parental data for a removed multi-account entry. */
export function purgeParentalForAccount(accountId) {
  const id = String(accountId || '')
    .trim()
    .toLowerCase();
  if (!id) return;
  for (const key of [KEYS.profiles, KEYS.adultPin]) {
    const store = readAccountMap(key);
    if (store[id] === undefined) continue;
    const next = { ...store };
    delete next[id];
    write(key, next);
  }
}

// ---- Adult PIN (required for XXX) ------------------------------------------

export function getAdultPin() {
  const v = getAccountValue(KEYS.adultPin, KEYS.adultPinLegacy, null);
  if (v == null || v === '') return null;
  return String(v);
}

export function saveAdultPin(pin) {
  setAccountValue(KEYS.adultPin, String(pin || ''));
}

export function clearAdultPin() {
  clearAccountValue(KEYS.adultPin);
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
    const aid = accountKey();
    sessionStorage.setItem(ADULT_UNLOCK_KEY, JSON.stringify({ aid, cat: String(categoryId ?? '') }));
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

function readAdultBrowseUnlock() {
  try {
    const raw = sessionStorage.getItem(ADULT_UNLOCK_KEY);
    if (!raw) return null;
    // Legacy: plain category id string
    if (raw[0] !== '{') return { aid: accountKey(), cat: raw };
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getAdultBrowseUnlock() {
  const u = readAdultBrowseUnlock();
  if (!u) return null;
  if (u.aid && u.aid !== accountKey()) return null;
  return u.cat ?? null;
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
  const v = getAccountValue(KEYS.profiles, KEYS.profilesLegacy, null);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return {
      profiles: Array.isArray(v.profiles) ? v.profiles : [],
      active: String(v.active || ''),
    };
  }
  return { profiles: [], active: '' };
}

export function saveParentalState(state) {
  setAccountValue(KEYS.profiles, {
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
