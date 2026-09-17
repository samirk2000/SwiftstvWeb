// Audio / subtitle track helpers for HLS.js + native <video>.
// Best-effort: TV browsers often lack AC3/EAC3 and may expose 0–N tracks.
// Mirrors Android AudioTrackHelper label + Spanish preference.

const ES_LANG = ['spa', 'es', 'es-mx', 'es-es', 'lat', 'latino', 'spanish', 'castellano'];
const EN_LANG = ['eng', 'en', 'english'];

function normLang(s) {
  return String(s || '').toLowerCase().trim();
}

export function friendlyAudioLabel(track, index = 0) {
  const lang = normLang(track?.lang || track?.language || track?.name || '');
  const name = String(track?.name || track?.label || '').trim();
  if (ES_LANG.some((k) => lang.includes(k) || name.toLowerCase().includes(k))) {
    return name && !/^audio/i.test(name) ? `Español · ${name}` : 'Español';
  }
  if (EN_LANG.some((k) => lang.includes(k) || name.toLowerCase().includes(k))) {
    return name && !/^audio/i.test(name) ? `English · ${name}` : 'English';
  }
  if (name) return name;
  if (lang) return lang.toUpperCase();
  return `Audio ${index + 1}`;
}

export function friendlyTextLabel(track, index = 0) {
  const lang = normLang(track?.lang || track?.language || '');
  const name = String(track?.name || track?.label || '').trim();
  if (ES_LANG.some((k) => lang.includes(k) || name.toLowerCase().includes(k))) {
    return 'Español';
  }
  if (EN_LANG.some((k) => lang.includes(k) || name.toLowerCase().includes(k))) {
    return 'English';
  }
  if (name) return name;
  if (lang) return lang.toUpperCase();
  return `Subs ${index + 1}`;
}

function scoreAudio(track) {
  const lang = normLang(track?.lang || track?.language || track?.name || '');
  let s = 0;
  if (ES_LANG.some((k) => lang.includes(k))) s += 800;
  else if (EN_LANG.some((k) => lang.includes(k))) s += 200;
  return s;
}

/** Snapshot of selectable tracks from an HLS.js controller or native video. */
export function collectTracks(player, videoEl) {
  const audio = [];
  const text = [];

  if (player?.hls) {
    const hls = player.hls;
    (hls.audioTracks || []).forEach((t, i) => {
      audio.push({ id: i, label: friendlyAudioLabel(t, i), lang: t.lang || '' });
    });
    (hls.subtitleTracks || []).forEach((t, i) => {
      text.push({ id: i, label: friendlyTextLabel(t, i), lang: t.lang || '' });
    });
    return {
      audio,
      text,
      audioId: typeof hls.audioTrack === 'number' ? hls.audioTrack : 0,
      textId: typeof hls.subtitleTrack === 'number' ? hls.subtitleTrack : -1,
      source: 'hls',
    };
  }

  // Native <video> — audioTracks is sparse on Chromium/TV; textTracks more common.
  try {
    const aTracks = videoEl?.audioTracks;
    if (aTracks && aTracks.length) {
      for (let i = 0; i < aTracks.length; i += 1) {
        const t = aTracks[i];
        audio.push({
          id: i,
          label: friendlyAudioLabel({ lang: t.language, name: t.label }, i),
          lang: t.language || '',
        });
      }
    }
  } catch {
    /* AudioTrackList not supported */
  }

  try {
    const tTracks = videoEl?.textTracks;
    if (tTracks && tTracks.length) {
      for (let i = 0; i < tTracks.length; i += 1) {
        const t = tTracks[i];
        const kind = String(t.kind || '').toLowerCase();
        if (kind && kind !== 'subtitles' && kind !== 'captions') continue;
        text.push({
          id: i,
          label: friendlyTextLabel({ lang: t.language, name: t.label }, text.length),
          lang: t.language || '',
        });
      }
    }
  } catch {
    /* ignore */
  }

  let audioId = 0;
  try {
    const aTracks = videoEl?.audioTracks;
    if (aTracks) {
      for (let i = 0; i < aTracks.length; i += 1) {
        if (aTracks[i].enabled) {
          audioId = i;
          break;
        }
      }
    }
  } catch {
    /* ignore */
  }

  let textId = -1;
  try {
    const tTracks = videoEl?.textTracks;
    if (tTracks) {
      for (let i = 0; i < tTracks.length; i += 1) {
        if (tTracks[i].mode === 'showing') {
          textId = i;
          break;
        }
      }
    }
  } catch {
    /* ignore */
  }

  return { audio, text, audioId, textId, source: 'native' };
}

export function applyAudioTrack(player, videoEl, id) {
  if (player?.hls) {
    try {
      player.hls.audioTrack = id;
      return true;
    } catch {
      return false;
    }
  }
  try {
    const tracks = videoEl?.audioTracks;
    if (!tracks || !tracks.length) return false;
    for (let i = 0; i < tracks.length; i += 1) {
      tracks[i].enabled = i === id;
    }
    return true;
  } catch {
    return false;
  }
}

/** id === -1 disables subtitles. */
export function applyTextTrack(player, videoEl, id) {
  if (player?.hls) {
    try {
      player.hls.subtitleDisplay = id >= 0;
      player.hls.subtitleTrack = id;
      return true;
    } catch {
      return false;
    }
  }
  try {
    const tracks = videoEl?.textTracks;
    if (!tracks) return false;
    for (let i = 0; i < tracks.length; i += 1) {
      const kind = String(tracks[i].kind || '').toLowerCase();
      if (kind && kind !== 'subtitles' && kind !== 'captions') continue;
      tracks[i].mode = i === id ? 'showing' : 'disabled';
    }
    return true;
  } catch {
    return false;
  }
}

/** Prefer Spanish (then English) once when tracks first appear — Android parity. */
export function pickPreferredAudioId(audioList) {
  if (!audioList?.length) return 0;
  let best = 0;
  let bestScore = -1;
  audioList.forEach((t, i) => {
    const s = scoreAudio(t);
    if (s > bestScore) {
      bestScore = s;
      best = t.id != null ? t.id : i;
    }
  });
  return best;
}

export function cycleNextId(list, currentId, { includeOff = false } = {}) {
  if (includeOff) {
    // Off (-1) → first → … → last → Off
    if (!list?.length) return -1;
    if (currentId < 0) return list[0].id;
    const idx = list.findIndex((t) => t.id === currentId);
    if (idx < 0) return list[0].id;
    if (idx >= list.length - 1) return -1;
    return list[idx + 1].id;
  }
  if (!list?.length) return currentId;
  const idx = list.findIndex((t) => t.id === currentId);
  const next = list[(idx < 0 ? 0 : idx + 1) % list.length];
  return next.id;
}
