// Text clean-up for TV fonts.
//
// Panels put decorative symbols in channel / event / category names
// ("20:00 ◘ AEW Dynamite", "🔥 EVENTOS DIARIOS"). Most Smart TV fonts (webOS,
// Tizen, Vidaa) have no glyph for them and paint a box (□). We turn the
// "separator" shapes into a plain " · " and drop emoji / pictographs.

// Geometric shapes / box drawing / block elements used as separators.
const SEPARATORS = /\s*[\u2500-\u25FF\u2022\u2023\u2043\u2219\u29BF]+\s*/g;
// Emoji, pictographs, dingbats, misc symbols, flags, keycaps, variation selectors, ZWJ.
const PICTOGRAPHS = /(?:[\u2600-\u27BF\u2B00-\u2BFF\u2190-\u21FF\u2300-\u23FF\uFE0E\uFE0F\u200D\u20E3\uFFFD]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF])/g;
// Leftover C0/C1 control characters.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function cleanTitle(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Fast path: plain ASCII / Latin text needs no work.
  if (!/[^\u0000-\u024F]/.test(s) && !CONTROL.test(s)) return s.trim();
  CONTROL.lastIndex = 0;
  const out = s
    .replace(CONTROL, '')
    .replace(SEPARATORS, ' · ')
    .replace(PICTOGRAPHS, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:\s*·\s*)+|(?:\s*·\s*)+$/g, '')
    .replace(/(?:\s*·\s*){2,}/g, ' · ')
    .trim();
  return out || s.trim();
}

/** Base64 → UTF-8 string (Xtream short_epg titles/descriptions are base64). */
export function decodeBase64Utf8(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  // Only decode things that really look like base64.
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s) || s.length % 4 === 1) return s;
  try {
    const bin = atob(s.replace(/\s+/g, ''));
    if (typeof TextDecoder !== 'undefined') {
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const out = new TextDecoder('utf-8').decode(bytes);
      return /[\uFFFD\u0000-\u0008]/.test(out) ? s : out;
    }
    // eslint-disable-next-line no-undef
    return decodeURIComponent(escape(bin));
  } catch {
    return s;
  }
}

/** True when a body/name is a CDN / Cloudflare / nginx error page, not content. */
export function looksLikeErrorPage(text) {
  const s = String(text || '').slice(0, 4000).toLowerCase();
  if (!s) return false;
  return (
    /error code:? ?5\d\d|error code:? ?10\d\d|connection timed out|additional troubleshooting|web server is down|origin is unreachable|bad gateway|gateway time-?out|attention required|just a moment|checking your browser|access denied|ray id|cf-error|cloudflare\.com\)|403 forbidden|404 not found|502 bad|503 service|504 gateway/.test(s)
  );
}

/** Lighter poster for grids: TMDB w600/original → w342 (TV browsers load 4× faster). */
export function gridPoster(url) {
  const s = String(url || '').trim();
  if (!s) return undefined;
  const m = /^(?:https?:)?\/\/image\.tmdb\.org\/t\/p\/[^/]+\/(.+)$/i.exec(s);
  if (m) return `https://image.tmdb.org/t/p/w342/${m[1]}`;
  return s;
}

/** First image URL from a backdrop field (array, "['url']" string or plain URL). */
export function firstBackdrop(v) {
  if (Array.isArray(v)) return v.find((x) => typeof x === 'string' && /^https?:/i.test(x)) || '';
  if (typeof v === 'string') {
    const m = v.match(/https?:[^'"\],\s]+/);
    return m ? m[0] : '';
  }
  return '';
}
