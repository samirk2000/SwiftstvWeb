import { useCallback, useEffect, useState } from 'react';

// Persists the last selected category per catalog (live/vod/series) in
// sessionStorage. When the user leaves to the player/detail and comes back, the
// list remounts on the SAME category instead of reloading "Todas" (which would
// render + download hundreds of posters at once).
const KEY = (scope) => `swiftstv_${scope}_category`;

function readStored(scope) {
  try {
    return sessionStorage.getItem(KEY(scope)) || '';
  } catch {
    return '';
  }
}

export function usePersistedCategory(scope) {
  const [catId, setCatId] = useState(() => readStored(scope));

  useEffect(() => {
    try {
      sessionStorage.setItem(KEY(scope), catId);
    } catch {
      // sessionStorage unavailable (e.g. blocked) — persistence is best-effort.
    }
  }, [scope, catId]);

  const select = useCallback((id) => setCatId(id === undefined ? '' : String(id)), []);
  return [catId, select];
}
