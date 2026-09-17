// Probe + switch embedded audio (MKV/MP4 dual LAT/ENG) when the browser
// hides HTMLMediaElement.audioTracks (Chromium / most TV browsers).
// Uses mediabunny to read track metadata and remux a single selected audio
// into a playable MP4 blob window (rolling) so EAC3 dual titles actually switch.
//
// IMPORTANT: every UrlSource hit the panel as an extra connection. Always
// dispose/cancel on destroy or episode change, and never prefetch a second window
// while one is already remuxing (that left S01E01 "Online" after tapping Siguiente).

import {
  ALL_FORMATS,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
} from 'mediabunny';
import { friendlyAudioLabel } from './tracks.js';

const WINDOW_SECS = 90;

/** In-flight remux/probe jobs — hardStop / episode swap cancels all of them. */
const LIVE_JOBS = new Set();

function trackJob(job) {
  LIVE_JOBS.add(job);
  return job;
}

function untrackJob(job) {
  LIVE_JOBS.delete(job);
}

/** Cancel every remux/probe so the panel drops the previous episode immediately. */
export async function cancelAllContainerAudioJobs() {
  const jobs = [...LIVE_JOBS];
  LIVE_JOBS.clear();
  await Promise.all(
    jobs.map(async (job) => {
      try {
        if (typeof job.cancel === 'function') await job.cancel();
      } catch {
        /* ignore */
      }
      try {
        if (typeof job.dispose === 'function') job.dispose();
      } catch {
        /* ignore */
      }
    })
  );
}

function scoreLang(lang, name) {
  const s = `${lang || ''} ${name || ''}`.toLowerCase();
  if (/(spa|es-mx|es-es|\bes\b|lat|latino|spanish|castellano)/.test(s)) return 800;
  if (/(eng|\ben\b|english)/.test(s)) return 200;
  if (/(por|pt|brazil)/.test(s)) return 100;
  return 0;
}

function makeUrlSource(url) {
  return new UrlSource(String(url), {
    getRetryDelay: ({ retryCount }) => (retryCount < 2 ? 300 * (retryCount + 1) : null),
  });
}

/** List audio tracks from a progressive/MKV/MP4 URL (proxied https). */
export async function probeContainerAudioTracks(url, { signal } = {}) {
  if (!url) return [];
  if (signal?.aborted) return [];
  const input = new Input({
    source: makeUrlSource(url),
    formats: ALL_FORMATS,
  });
  const job = {
    cancel: async () => {
      try {
        input.dispose?.();
      } catch {
        /* ignore */
      }
    },
    dispose: () => {
      try {
        input.dispose?.();
      } catch {
        /* ignore */
      }
    },
  };
  trackJob(job);
  try {
    if (signal?.aborted) return [];
    const tracks = await input.getAudioTracks();
    if (signal?.aborted) return [];
    const out = [];
    for (let i = 0; i < tracks.length; i += 1) {
      const t = tracks[i];
      const lang = (await t.getLanguageCode().catch(() => '')) || '';
      const name = t.name || '';
      const codec = t.codec || '';
      out.push({
        id: t.id,
        index: i,
        lang,
        name,
        codec,
        label: friendlyAudioLabel({ lang, name }, i),
        score: scoreLang(lang, name),
      });
    }
    out.sort((a, b) => b.score - a.score || a.index - b.index);
    return out;
  } catch {
    return [];
  } finally {
    untrackJob(job);
    try {
      input.dispose?.();
    } catch {
      /* ignore */
    }
  }
}

async function remuxWindow(sourceUrl, audioTrackId, start, end, signal) {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  const input = new Input({
    source: makeUrlSource(sourceUrl),
    formats: ALL_FORMATS,
  });
  const chunks = [];
  const { readable, writable } = new TransformStream();
  const reader = readable.getReader();
  let conversion = null;
  const job = {
    cancel: async () => {
      try {
        if (conversion) await conversion.cancel();
      } catch {
        /* ignore */
      }
      try {
        input.dispose?.();
      } catch {
        /* ignore */
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    },
    dispose: () => {
      try {
        input.dispose?.();
      } catch {
        /* ignore */
      }
    },
  };
  trackJob(job);

  const onAbort = () => {
    void job.cancel();
  };
  if (signal) {
    if (signal.aborted) {
      untrackJob(job);
      try {
        input.dispose?.();
      } catch {
        /* ignore */
      }
      throw new DOMException('aborted', 'AbortError');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const consume = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const data = value?.data || value;
      if (data) chunks.push(data instanceof Uint8Array ? data : new Uint8Array(data));
    }
  })();

  try {
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1.5 }),
      target: new StreamTarget(writable),
    });
    conversion = await Conversion.init({
      input,
      output,
      trim: { start: Math.max(0, start), end: Math.max(start + 1, end) },
      audio: (track) => (track.id === audioTrackId ? {} : { discard: true }),
    });
    if (!conversion.isValid) {
      throw new Error('remux-invalid');
    }
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    await conversion.execute();
    await consume;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return new Blob(chunks, { type: 'video/mp4' });
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    untrackJob(job);
    try {
      if (conversion && conversion.state === 'executing') await conversion.cancel();
    } catch {
      /* ignore */
    }
    try {
      input.dispose?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Play `sourceUrl` with only `audioTrackId` remuxed into rolling MP4 windows.
 * Returns a small controller { destroy, getAbsoluteTime, seekAbsolute }.
 * No background prefetch — that opened a 2nd panel connection and survived "Siguiente".
 */
export function attachRemuxedAudio(videoEl, sourceUrl, audioTrackId, opts = {}) {
  let destroyed = false;
  let windowStart = Math.max(0, Number(opts.startPosition) || 0);
  let objectUrl = '';
  let abort = new AbortController();
  let onEnded = null;
  let swapping = false;
  let loadPromise = null;

  const clearSrc = () => {
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore */
      }
      objectUrl = '';
    }
    try {
      videoEl.removeAttribute('src');
      videoEl.src = '';
      videoEl.load();
    } catch {
      /* ignore */
    }
  };

  const playBlob = async (blob, startAbs) => {
    clearSrc();
    objectUrl = URL.createObjectURL(blob);
    windowStart = startAbs;
    videoEl.src = objectUrl;
    videoEl.load();
    try {
      await videoEl.play();
    } catch {
      /* autoplay / AbortError */
    }
    if (typeof opts.onReady === 'function') {
      try {
        opts.onReady();
      } catch {
        /* ignore */
      }
    }
  };

  const loadWindow = async (startAbs) => {
    if (destroyed) return;
    abort.abort();
    abort = new AbortController();
    const endAbs = startAbs + WINDOW_SECS;
    if (typeof opts.onProgress === 'function') {
      try {
        opts.onProgress({ phase: 'remux', start: startAbs });
      } catch {
        /* ignore */
      }
    }
    const blob = await remuxWindow(sourceUrl, audioTrackId, startAbs, endAbs, abort.signal);
    if (destroyed) return;
    await playBlob(blob, startAbs);
  };

  onEnded = async () => {
    if (destroyed || swapping) return;
    swapping = true;
    try {
      loadPromise = loadWindow(windowStart + WINDOW_SECS);
      await loadPromise;
    } catch (err) {
      if (!destroyed && err?.name !== 'AbortError' && typeof opts.onError === 'function') {
        opts.onError(err);
      }
    } finally {
      swapping = false;
      loadPromise = null;
    }
  };

  videoEl.addEventListener('ended', onEnded);

  const boot = loadWindow(windowStart).catch((err) => {
    if (!destroyed && err?.name !== 'AbortError' && typeof opts.onError === 'function') {
      opts.onError(err);
    }
  });

  return {
    kind: 'remux',
    audioTrackId,
    ready: boot,
    getAbsoluteTime: () => windowStart + (videoEl.currentTime || 0),
    async seekAbsolute(t) {
      const target = Math.max(0, Number(t) || 0);
      const local = target - windowStart;
      const dur = videoEl.duration || 0;
      if (local >= 0 && local < dur - 1) {
        try {
          videoEl.currentTime = local;
        } catch {
          /* ignore */
        }
        return;
      }
      await loadWindow(target);
    },
    async destroy() {
      destroyed = true;
      abort.abort();
      videoEl.removeEventListener('ended', onEnded);
      clearSrc();
      // Kill any UrlSource still hitting the panel for this / previous window.
      await cancelAllContainerAudioJobs();
    },
  };
}

export function pickPreferredContainerAudioId(tracks) {
  if (!tracks?.length) return null;
  return tracks[0].id;
}
