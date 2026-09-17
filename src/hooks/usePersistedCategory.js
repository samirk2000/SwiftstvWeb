import { useCallback, useEffect, useState } from 'react';

// Persists the last selected category per catalog (live/vod/series) in
// sessionStorage. `null` = never chosen yet (we'll pick the first category so
// TVs don't fetch+render the entire catalog on open). `''` = user chose "Todos".
const KEY = (scope) => `swiftstv_${scope}_category_v2`;

function readStored(scope) {
  try {
    const v = sessionStorage.getItem(KEY(scope));
    if (v === null) return null;
    return v;
  } catch {
    return null;
  }
}

export function usePersistedCategory(scope) {
  const [catId, setCatIdState] = useState(() => readStored(scope));

  useEffect(() => {
    if (catId === null) return;
    try {
      sessionStorage.setItem(KEY(scope), catId);
    } catch {
      // sessionStorage unavailable — persistence is best-effort.
    }
  }, [scope, catId]);

  const setCatId = useCallback((id) => {
    if (id === null || id === undefined) setCatIdState(null);
    else setCatIdState(String(id));
  }, []);

  return [catId, setCatId];
}
