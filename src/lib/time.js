// Small helpers for EPG / times (no external deps).

// Xtream short_epg entries carry start in epoch seconds and a title.
// Format an epoch-second timestamp as HH:MM (already local-time via Date).
export function formatEpgTime(epochSeconds) {
  if (!epochSeconds && epochSeconds !== 0) return '';
  const d = new Date(epochSeconds * 1000);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// Normalise a run length (seconds) to "1h 23m" / "45m".
export function formatDuration(seconds) {
  const s = Number(seconds) || 0;
  if (s <= 0) return '';
  const mins = Math.floor(s / 60);
  const h = Math.floor(mins / 60);
  const rem = mins % 60;
  if (h > 0) return `${h}h ${rem}m`;
  return `${rem}m`;
}

// Format an ISO or epoch exp_date into a readable date, or '' if none.
export function formatExpiry(expDate) {
  if (!expDate || expDate === '0' || String(expDate).toLowerCase() === 'null') return '';
  const n = Number(expDate);
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n * 1000);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
  }
  return String(expDate);
}

// The currently-playing programme for a channel given its EPG list.
export function currentProgramme(epg) {
  if (!Array.isArray(epg) || !epg.length) return null;
  const now = Date.now() / 1000;
  return epg.find((e) => Number(e.start) <= now && Number(e.stop || 0) > now) || null;
}

// Local epoch seconds for `dayOffset` days ago (0 = today) at the given hour.
// Used by the catch-up selector to build a programme window from a picked
// date + hour (startEpoch), independent of the short EPG list.
export function epochAtLocal(dayOffset = 0, hour = 0) {
  const d = new Date();
  d.setDate(d.getDate() - dayOffset);
  d.setHours(hour, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// Short "18 Aug" style label for a day offset (0 = today), locale-aware.
export function shortDayLabel(dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - dayOffset);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
