/** Pick the first non-empty synopsis-like string from panel metadata. */
export function pickSynopsis(...candidates) {
  for (const raw of candidates) {
    if (raw == null) continue;
    const s = String(raw).replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const lower = s.toLowerCase();
    if (lower === 'null' || lower === 'undefined' || lower === 'n/a' || lower === '-') continue;
    if (s.length < 12) continue; // ignore tiny placeholders
    return s;
  }
  return '';
}

/** Collect useful detail chips when the panel provides them. */
export function pickMetaBits(obj = {}) {
  const bits = [];
  const year = obj.year || obj.releaseDate || obj.releasedate;
  if (year) bits.push(String(year).slice(0, 4));
  const rating = obj.rating || obj.score;
  if (rating && String(rating) !== '0') bits.push(`★ ${rating}`);
  const dur = obj.duration || obj.episode_run_time;
  if (dur) bits.push(String(dur));
  const genre = obj.genre || obj.category;
  if (genre) bits.push(String(genre));
  const director = obj.director;
  if (director) bits.push(String(director));
  const cast = obj.cast || obj.actors;
  if (cast) bits.push(String(cast));
  return bits;
}
