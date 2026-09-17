/** Fold accents / case so "ninos" matches "NIÑOS" and "encanto" matches "Encánto". */
export function normalizeSearch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `haystack` contains `needle` after accent/case folding. */
export function matchesSearch(haystack, needle) {
  const q = normalizeSearch(needle);
  if (!q) return true;
  return normalizeSearch(haystack).includes(q);
}
