import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bufferedAhead,
  rangeContaining,
  hasBufferedData,
  snapToBuffered,
  recoverLivePlayback,
  liveHasVisibleFrames,
  whenStartBuffered,
  LIVE_START_AHEAD_S,
} from './liveBuffer.js';

function fakeVideo({ currentTime = 0, ranges = [], paused = true, readyState = 0, videoWidth = 0 } = {}) {
  const listeners = new Map();
  const video = {
    currentTime,
    paused,
    readyState,
    videoWidth,
    _ranges: ranges.map((r) => [...r]),
    get buffered() {
      const list = this._ranges;
      return {
        get length() {
          return list.length;
        },
        start(i) {
          if (i < 0 || i >= list.length) throw new Error('IndexSizeError');
          return list[i][0];
        },
        end(i) {
          if (i < 0 || i >= list.length) throw new Error('IndexSizeError');
          return list[i][1];
        },
      };
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    addEventListener(type, fn) {
      const arr = listeners.get(type) || [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type) || [];
      listeners.set(type, arr.filter((x) => x !== fn));
    },
    emit(type) {
      for (const fn of listeners.get(type) || []) fn();
    },
  };
  return video;
}

describe('bufferedAhead / rangeContaining', () => {
  it('returns 0 when there is no buffer', () => {
    const v = fakeVideo();
    assert.equal(hasBufferedData(v), false);
    assert.equal(bufferedAhead(v), 0);
    assert.equal(rangeContaining(v), null);
  });

  it('does not treat a live range far ahead of currentTime=0 as "ahead"', () => {
    // The bug: old ahead() did end-start = 3 even when the head was at 0
    // and the only data lived at t=1000, so play() started in a hole.
    const v = fakeVideo({ currentTime: 0, ranges: [[1000, 1003]] });
    assert.equal(hasBufferedData(v), true);
    assert.equal(bufferedAhead(v), 0);
    assert.equal(rangeContaining(v), null);
  });

  it('counts only the range that contains the playback head', () => {
    const v = fakeVideo({ currentTime: 1001, ranges: [[10, 12], [1000, 1005]] });
    assert.equal(bufferedAhead(v), 4);
    assert.deepEqual(rangeContaining(v), { start: 1000, end: 1005 });
  });
});

describe('snapToBuffered', () => {
  it('seeks from 0 into the live range instead of leaving a hole', () => {
    const v = fakeVideo({ currentTime: 0, ranges: [[1000, 1006]] });
    assert.equal(snapToBuffered(v, { keepSeconds: 2 }), true);
    assert.ok(v.currentTime >= 1000);
    assert.ok(v.currentTime < 1006);
    assert.ok(v.currentTime >= 1004 - 0.01); // near live edge minus keepSeconds
    assert.ok(bufferedAhead(v) >= 1.5);
  });

  it('does not seek when the head is already in a healthy range', () => {
    const v = fakeVideo({ currentTime: 1002, ranges: [[1000, 1006]] });
    const before = v.currentTime;
    assert.equal(snapToBuffered(v), false);
    assert.equal(v.currentTime, before);
  });

  it('never seeks outside the buffered range (avoids mpegts flush)', () => {
    const v = fakeVideo({ currentTime: 0, ranges: [[50, 51.2]] });
    snapToBuffered(v, { keepSeconds: 2 });
    assert.ok(v.currentTime >= 50);
    assert.ok(v.currentTime < 51.2);
  });

  it('returns false when there is nothing to snap to', () => {
    const v = fakeVideo({ currentTime: 0, ranges: [] });
    assert.equal(snapToBuffered(v), false);
    assert.equal(v.currentTime, 0);
  });
});

describe('recoverLivePlayback', () => {
  it('snaps a stalled head at 0 and resumes a paused live video', () => {
    const v = fakeVideo({
      currentTime: 0,
      ranges: [[200, 206]],
      paused: true,
      readyState: 2,
    });
    const status = recoverLivePlayback(v);
    assert.equal(status, 'snapped-resumed');
    assert.equal(v.paused, false);
    assert.ok(v.currentTime >= 200 && v.currentTime < 206);
  });

  it('resumes a paused video whose head is already in-buffer', () => {
    const v = fakeVideo({ currentTime: 201, ranges: [[200, 206]], paused: true });
    assert.equal(recoverLivePlayback(v), 'resumed');
    assert.equal(v.paused, false);
  });

  it('returns ok when the channel is already playing with buffer', () => {
    const v = fakeVideo({ currentTime: 201, ranges: [[200, 206]], paused: false, readyState: 3, videoWidth: 1280 });
    assert.equal(recoverLivePlayback(v), 'ok');
    assert.equal(liveHasVisibleFrames(v), true);
  });

  it('does not claim visible frames for a black / paused / out-of-range head', () => {
    assert.equal(liveHasVisibleFrames(fakeVideo({ currentTime: 0, ranges: [[10, 13]], paused: false, readyState: 3, videoWidth: 0 })), false);
    assert.equal(liveHasVisibleFrames(fakeVideo({ currentTime: 11, ranges: [[10, 13]], paused: true, readyState: 3, videoWidth: 1920 })), false);
    assert.equal(liveHasVisibleFrames(fakeVideo({ currentTime: 0, ranges: [[10, 13]], paused: false, readyState: 3, videoWidth: 1920 })), false);
  });
});

describe('whenStartBuffered', () => {
  it('exports a 3 second start runway', () => {
    assert.equal(LIVE_START_AHEAD_S, 3);
  });

  it('resolves after the head is snapped into a live range with enough runway', async () => {
    const v = fakeVideo({ currentTime: 0, ranges: [] });
    const pending = whenStartBuffered(v, { minAhead: 1.5, maxWaitMs: 2000, hardCapMs: 1500 });
    // Data arrives at a live timestamp — the helper must snap, then resolve
    // because ahead after the snap (keepSeconds=2 on a 6s range) is ~2s.
    v._ranges.push([4000, 4006]);
    v.emit('progress');
    const elapsed = await pending;
    assert.ok(elapsed < 400);
    assert.ok(v.currentTime >= 4000 && v.currentTime < 4006);
    assert.ok(bufferedAhead(v) >= 1.5);
  });

  it('resolves on the hard cap even if the buffer never fills', async () => {
    const v = fakeVideo({ currentTime: 0, ranges: [] });
    const elapsed = await whenStartBuffered(v, { minAhead: 3, maxWaitMs: 5000, hardCapMs: 80 });
    assert.ok(elapsed >= 80);
    assert.ok(elapsed < 500);
    assert.equal(v.currentTime, 0);
  });

  it('resolves once some in-range data has been waiting maxWaitMs', async () => {
    const v = fakeVideo({ currentTime: 10.2, ranges: [[10, 11]] }); // only ~0.8s ahead
    const elapsed = await whenStartBuffered(v, { minAhead: 3, maxWaitMs: 70, hardCapMs: 2000 });
    assert.ok(elapsed >= 70);
    assert.ok(elapsed < 600);
    // Head stays in the original range (already in-buffer, no snap needed).
    assert.ok(v.currentTime >= 10 && v.currentTime < 11);
  });
});

describe('pre-buffer deadlock and HLS/TS fallback scenarios', () => {
  it('a start-gate that used the old ahead() math would open while still in a hole', () => {
    const v = fakeVideo({ currentTime: 0, ranges: [[800, 804]] });
    // Recreate the old (buggy) calculation so the regression is explicit.
    const b = v.buffered;
    const ct = v.currentTime || 0;
    let oldAhead = 0;
    for (let i = 0; i < b.length; i += 1) {
      if (b.end(i) > ct) oldAhead = b.end(i) - Math.max(ct, b.start(i));
    }
    assert.equal(oldAhead, 4);
    assert.equal(bufferedAhead(v), 0);
    // After the fix, recoverLivePlayback places the head in the range and plays.
    recoverLivePlayback(v);
    assert.equal(v.paused, false);
    assert.ok(bufferedAhead(v) > 0);
  });

  it('channel switch: a stale whenStartBuffered must not unpause a replaced element', async () => {
    // We only resolve; the caller is responsible for checking the controller
    // still owns the element. This test documents that the helper itself does
    // not call play() — so a superseded attach cannot unpause a new channel.
    const v = fakeVideo({ currentTime: 0, ranges: [] });
    const p = whenStartBuffered(v, { hardCapMs: 50 });
    const elapsed = await p;
    assert.ok(elapsed >= 50);
    assert.equal(v.paused, true);
  });
});
