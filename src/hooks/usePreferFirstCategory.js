import { useEffect } from 'react';

/**
 * On first visit (catId === null), lock onto the first unlocked category.
 * Avoids "Todos" dumping thousands of rows into a TV WebKit/Chromium.
 */
export function usePreferFirstCategory(catId, setCatId, visibleCats, searchActive) {
  useEffect(() => {
    if (searchActive) return;
    if (catId !== null) return;
    if (!visibleCats?.length) return;
    setCatId(String(visibleCats[0].category_id));
  }, [catId, setCatId, visibleCats, searchActive]);
}
