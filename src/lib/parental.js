// Parental gate by PIN. Restricts category_ids per profile, stored in
// localStorage. By default there is NO PIN and nothing is blocked — a content
// lock is only enforced once an admin sets a PIN and selects blocked
// categories for a profile.

const KEYS = {
  profiles: 'swiftstv.parental.profiles.v1',
  active: 'swiftstv.parental.active.v1',
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

// The whole parental registry. `active` is the currently in-use profile (by
// id). `profiles` holds each profile's PIN + blocked category ids.
export function getParentalState() {
  return read(KEYS.profiles, { profiles: [], active: '' });
}

export function saveParentalState(state) {
  write(KEYS.profiles, {
    profiles: Array.isArray(state?.profiles) ? state.profiles : [],
    active: String(state?.active || ''),
  });
}

// The currently active profile, or null when the gate is off.
export function getActiveProfile() {
  const state = getParentalState();
  if (!state.active) return null;
  return state.profiles.find((p) => p.id === state.active) || null;
}

// True when the gate is on and this category id is blocked by the active
// profile. When no PIN/profile is set, nothing is blocked (defaults open).
export function isCategoryLocked(categoryId) {
  const profile = getActiveProfile();
  if (!profile) return false;
  const blocked = Array.isArray(profile.blockedCategoryIds) ? profile.blockedCategoryIds : [];
  return blocked.some((cid) => String(cid) === String(categoryId));
}

export function isParentalEnabled() {
  return Boolean(getActiveProfile()?.pin);
}

// Create or update a profile. Passing an empty pin clears the lock.
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

// Verify a PIN against the active profile before entering the admin area.
export function verifyPin(pin) {
  const profile = getActiveProfile();
  return Boolean(profile && profile.pin && String(profile.pin) === String(pin));
}
