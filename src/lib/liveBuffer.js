// Live-start helpers: measure real buffer ahead of the playback head, snap
// currentTime into a buffered range, hold play() until a short runway is
// ready, and recover a live <video> that would otherwise sit on a black
// screen (head parked at 0 while data lives at a live timestamp, browser
// paused after an underrun, etc.).
//
// Kept free of hls.js / mpegts.js / Vite env so unit tests can import it
// in plain Node.

export const LIVE_START_AHEAD_S = 3;

function rangesOf(videoEl) {
  const out = [];
  try {
    const b = videoEl?.buffered;
    if (!b) return out;
    for (let i = 0; i < b.length; i += 1) {
      const start = b.start(i);
      const end = b.end(i);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        out.push({ start, end });
      }
    }
  } catch {
    /* TimeRanges can throw if the media element is mid-teardown. */
  }
  return out;
}

export function hasBufferedData(videoEl) {
  return rangesOf(videoEl).length > 0;
}

/** The buffered range that contains `t` (default: currentTime), or null. */
export function rangeContaining(videoEl, t) {
  const ct = Number.isFinite(t) ? t : Number(videoEl?.currentTime) || 0;
  for (const r of rangesOf(videoEl)) {
    // Tiny epsilon so a head sitting exactly on a boundary still counts.
    if (ct >= r.start - 0.05 && ct < r.end - 0.05) return r;
  }
  return null;
}

/**
 * Seconds of media buffered AHEAD OF THE PLAYBACK HEAD.
 * A range that does not contain currentTime does not count — that is the
 * classic live-MSE trap (currentTime=0, data at t=1000+) that used to look
 * like "3 s buffered" and then play() from a hole, leaving a black screen.
 */
export function bufferedAhead(videoEl) {
  const ct = Number(videoEl?.currentTime) || 0;
  const r = rangeContaining(videoEl, ct);
  if (!r) return 0;
  return Math.max(0, r.end - ct);
}

/**
 * If the playback head is outside every buffered range (or sitting on a
 * razor-thin edge), seek to a safe point *inside* the newest range so the
 * browser can actually paint frames. Never seeks outside a range — an
 * unbuffered currentTime assignment makes mpegts.js flush the SourceBuffer
 * and try to seek a live TS socket, which kills the channel.
 *
 * Returns true when a seek was issued.
 */
export function snapToBuffered(videoEl, { keepSeconds = 2 } = {}) {
  if (!videoEl) return false;
  const ct = Number(videoEl.currentTime) || 0;
  const here = rangeContaining(videoEl, ct);
  if (here && here.end - ct >= 0.2) return false;
  const ranges = rangesOf(videoEl);
  if (!ranges.length) return false;
  const live = ranges[ranges.length - 1];
  const span = live.end - live.start;
  // Stay clearly inside the range so we never trigger an unbuffered flush.
  const insidePad = Math.min(0.15, Math.max(0.02, span * 0.05));
  let target;
  if (span <= keepSeconds + insidePad * 2) {
    target = live.start + insidePad;
  } else {
    target = Math.max(live.start + insidePad, live.end - keepSeconds);
  }
  if (target >= live.end) target = Math.max(live.start, live.end - insidePad);
  if (!Number.isFinite(target) || Math.abs(target - ct) < 0.05) return false;
  try {
    videoEl.currentTime = target;
    return true;
  } catch {
    return false;
  }
}

/** True when the element is actually showing moving video, not a black frame. */
export function liveHasVisibleFrames(videoEl) {
  if (!videoEl) return false;
  const width = Number(videoEl.videoWidth) || 0;
  if (width <= 0) return false;
  if (videoEl.paused) return false;
  if ((videoEl.readyState || 0) < 2) return false;
  return bufferedAhead(videoEl) > 0;
}

/**
 * One recovery tick for a live channel that started loading then went
 * black or silent: snap the head into the buffer and resume play if the
 * browser paused after an underrun. Returns a short status string.
 */
export function recoverLivePlayback(videoEl) {
  if (!videoEl) return 'missing';
  const ahead = bufferedAhead(videoEl);
  const inHole = hasBufferedData(videoEl) && ahead < 0.15;
  let snapped = false;
  if (inHole) snapped = snapToBuffered(videoEl);
  if (videoEl.paused) {
    try {
      const p = videoEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* autoplay / teardown */
    }
    return snapped ? 'snapped-resumed' : 'resumed';
  }
  if (snapped) return 'snapped';
  if (ahead >= 0.15 && !videoEl.paused) return 'ok';
  return 'waiting';
}

/**
 * Hold the first play() until ~3 s are buffered AHEAD OF THE HEAD (or
 * `maxWaitMs` after the head first sits in a range, whichever comes first;
 * hard cap `hardCapMs` so a slow channel never sits black). Snaps the head
 * into the buffered range as soon as data appears.
 */
export function whenStartBuffered(
  videoEl,
  { minAhead = LIVE_START_AHEAD_S, maxWaitMs = 4000, hardCapMs = 9000 } = {},
) {
  return new Promise((resolve) => {
    if (!videoEl) {
      resolve(0);
      return;
    }
    const t0 = Date.now();
    let firstInRange = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      try {
        videoEl.removeEventListener('progress', tick);
      } catch {
        /* ignore */
      }
      resolve(Date.now() - t0);
    };
    function tick() {
      if (finished) return;
      if (hasBufferedData(videoEl) && bufferedAhead(videoEl) < 0.15) {
        snapToBuffered(videoEl);
      }
      const a = bufferedAhead(videoEl);
      if (a > 0 && !firstInRange) firstInRange = Date.now();
      if (
        a >= minAhead ||
        (firstInRange && Date.now() - firstInRange >= maxWaitMs) ||
        Date.now() - t0 >= hardCapMs
      ) {
        // Last-chance snap so play() never starts in a hole.
        if (hasBufferedData(videoEl) && bufferedAhead(videoEl) < 0.15) {
          snapToBuffered(videoEl);
        }
        finish();
      }
    }
    const timer = setInterval(tick, 100);
    try {
      videoEl.addEventListener('progress', tick);
    } catch {
      /* ignore */
    }
    tick();
  });
}
