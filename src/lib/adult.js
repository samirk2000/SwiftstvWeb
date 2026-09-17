// Adult content heuristics — parity with Android ParentalGate / Roku LiveTVScene.
// Used to keep XXX out of Home, Seguir viendo, and "Recientes" (never history).

const ADULT_CATEGORY_KEYWORDS = [
  'adult',
  'xxx',
  '+18',
  '18+',
  'onlyfans',
  'porn',
  'erotic',
  'erotica',
  'adulto',
  'adultos',
  'nsfw',
  'hot ',
  'xxx-',
  'xxx ',
  'porno',
  'sexshop',
  'hustler',
  'brazzers',
  'playboy',
  'vivid',
];

const ADULT_TITLE_KEYWORDS = [
  'adult',
  'xxx',
  '+18',
  '18+',
  'onlyfans',
  'porn',
  'erotic',
  'adulto',
  'adultos',
  'nsfw',
  'xxx ',
  'brazzers',
  'playboy',
  'porno',
  'hentai',
  'xxx-',
];

function hasKeyword(text, keywords) {
  const n = String(text || '').toLowerCase();
  if (!n) return false;
  return keywords.some((k) => n.includes(k));
}

export function isAdultCategory(name) {
  return hasKeyword(name, ADULT_CATEGORY_KEYWORDS);
}

export function isAdultTitle(name) {
  return hasKeyword(name, ADULT_TITLE_KEYWORDS);
}

/** True when title or category folder looks adult — never write to recent / Home. */
export function isAdultContent(title, categoryName = '') {
  return isAdultTitle(title) || isAdultCategory(categoryName);
}
