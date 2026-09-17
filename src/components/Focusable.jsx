// Global TV remote / D-pad focus for webOS / Tizen / Android TV / Vidaa.
//
// webOS often IGNORES programmatic element.focus() until the page has had a
// mouse click. So we drive a VIRTUAL focus ring (class "tv-focused") that does
// not depend on document.activeElement. Arrow keys move that ring; OK clicks it.
// Native .focus() is still attempted as a best-effort for inputs / a11y.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
} from 'react';

/** LG webOS Back button */
export const LG_BACK_KEYCODE = 461;
/** Android TV / some remotes DPAD_CENTER */
const DPAD_CENTER = 23;

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[data-focusable="true"]',
  'article.tile',
  '.tile',
  '.channel',
  '.episode',
  '.menu-item',
  '.cat-chip',
  '.brand[role="button"]',
].join(',');

const STAMP_SELECTOR =
  'button, a[href], input:not([type="hidden"]), select, textarea, article.tile, .tile, .channel, .episode, .menu-item, .cat-chip, .back-btn, .fav-btn, .brand[role="button"], [role="button"]';

const FocusCtx = createContext(null);

/** Module-level virtual cursor — survives React re-renders, works without native focus. */
let currentFocused = null;
/** Ignore MutationObserver focus restores while setFocused is painting the ring. */
let focusPaintLock = false;
/** Stable key so remounted channel/tile rows can reclaim the ring instead of jumping to #1. */
let lastFocusKey = '';

/** While opening the IME, ignore blur restores that would kill the keyboard. */
let imeGuardEl = null;
let imeGuardUntil = 0;
/** Last input we tried to open the keyboard on (retry when window regains focus). */
let pendingImeEl = null;
let imeListenersInstalled = false;

export function markImeOpening(el, ms = 700) {
  if (!el) return;
  imeGuardEl = el;
  imeGuardUntil = Date.now() + ms;
  pendingImeEl = el;
}

export function isImeGuarded(el) {
  return Boolean(el && imeGuardEl === el && Date.now() < imeGuardUntil);
}

export function clearImeGuard() {
  imeGuardEl = null;
  imeGuardUntil = 0;
  pendingImeEl = null;
}

function showPlatformKeyboard() {
  try {
    const kb = window.webOS && window.webOS.keyboard;
    if (kb && typeof kb.show === 'function') kb.show();
  } catch {
    /* ignore */
  }
  try {
    if (window.PalmSystem && typeof window.PalmSystem.keyboardShow === 'function') {
      window.PalmSystem.keyboardShow(1);
    }
  } catch {
    /* ignore */
  }
}

function kickIme(realInput) {
  if (!realInput || !realInput.isConnected || realInput.disabled) return;
  try {
    window.focus();
  } catch {
    /* ignore */
  }
  try {
    realInput.readOnly = false;
    realInput.removeAttribute('readonly');
  } catch {
    /* ignore */
  }
  try {
    realInput.focus({ preventScroll: false });
  } catch {
    try {
      realInput.focus();
    } catch {
      /* ignore */
    }
  }
  // If focus didn't stick, one click can help; avoid clicking when already
  // focused (that can toggle the keyboard closed on some webOS builds).
  if (document.activeElement !== realInput) {
    try {
      if (typeof realInput.click === 'function') realInput.click();
    } catch {
      /* ignore */
    }
  }
  showPlatformKeyboard();
}

function flushPendingIme() {
  const el = pendingImeEl;
  if (!el || !el.isConnected) return;
  markImeOpening(el, 1200);
  setFocused(el, { native: false });
  kickIme(el);
  // One more kick after the window focus settles (simulator minimize case).
  window.setTimeout(() => kickIme(el), 80);
  window.setTimeout(() => kickIme(el), 200);
}

function ensureImeListeners() {
  if (imeListenersInstalled || typeof window === 'undefined') return;
  imeListenersInstalled = true;
  // Simulator often only paints the keyboard after the window is re-activated.
  window.addEventListener('focus', flushPendingIme);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flushPendingIme();
  });
  window.addEventListener('pageshow', flushPendingIme);
}

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.disabled) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}

export function queryFocusables(root) {
  const scope = root && root.querySelectorAll ? root : document;
  const list = Array.from(scope.querySelectorAll(FOCUSABLE_SELECTOR));
  const seen = new Set();
  const out = [];
  for (const el of list) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isVisible(el)) continue;
    // Nested row actions (Favoritos / catch-up) — only reachable via → from the row.
    if (el.dataset?.tvSecondary === 'true') continue;
    out.push(el);
  }
  return out;
}

/** Secondary controls inside a focused channel/tile row (→ to enter, ← to leave). */
function secondaryFocusables(row) {
  if (!row?.querySelectorAll) return [];
  return Array.from(row.querySelectorAll('[data-tv-secondary="true"]')).filter(isVisible);
}

/**
 * ONLY entry point that paints the cyan ring. Clears every previous marker first
 * so Username + Password can never both show tv-focused at once.
 */
export function setFocused(newEl, opts = {}) {
  const native = opts.native === true; // default false — caller opts in for IME
  focusPaintLock = true;

  document.querySelectorAll('.tv-focused, .focused, [data-tv-focused]').forEach((e) => {
    e.classList.remove('tv-focused');
    e.classList.remove('focused');
    e.removeAttribute('data-tv-focused');
  });

  currentFocused = null;

  if (!newEl || !newEl.isConnected) {
    // eslint-disable-next-line no-console
    console.log('[Focus] -> (none)');
    queueMicrotask(() => {
      focusPaintLock = false;
    });
    return false;
  }

  newEl.classList.add('tv-focused');
  newEl.classList.add('focused');
  newEl.setAttribute('data-tv-focused', 'true');
  currentFocused = newEl;
  if (newEl.dataset?.focusKey) lastFocusKey = String(newEl.dataset.focusKey);

  // eslint-disable-next-line no-console
  console.log('[Focus] ->', newEl.id || newEl.dataset?.loginField || newEl.dataset?.focusKey || newEl.tagName);

  // Drop native focus from any OTHER control so :focus can't paint a 2nd ring.
  const active = document.activeElement;
  if (active && active !== newEl && active !== document.body && active !== document.documentElement) {
    try {
      active.blur();
    } catch {
      /* ignore */
    }
  }

  if (native) {
    try {
      newEl.focus({ preventScroll: true });
    } catch {
      try {
        newEl.focus();
      } catch {
        /* webOS may refuse — virtual ring still works */
      }
    }
  }

  if (typeof newEl.scrollIntoView === 'function') {
    try {
      newEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    } catch {
      try {
        newEl.scrollIntoView(false);
      } catch {
        /* ignore */
      }
    }
  }

  queueMicrotask(() => {
    focusPaintLock = false;
  });
  return true;
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__tvSetFocused = (el) => setFocused(el, { native: false });
  window.__tvGetFocused = () => currentFocused;
}

/** @deprecated use setFocused — kept as alias so existing imports keep working. */
export function setTvFocus(el, opts = {}) {
  if (!el) return setFocused(null);
  // Preserve previous default (native true) for non-Login callers that expect it.
  const native = opts.native !== false;
  return setFocused(el, { native });
}

export function getTvFocus() {
  if (currentFocused && currentFocused.isConnected) return currentFocused;
  const painted =
    document.querySelector('[data-tv-focused="true"]') ||
    document.querySelector('.tv-focused');
  if (painted) {
    currentFocused = painted;
    return painted;
  }
  return null;
}

export function focusElement(el) {
  return setFocused(el, { native: true });
}

/** Prefer modal dialogs, then main content — never topbar brand on first paint. */
export function focusFirst(root) {
  const scope = root && root.querySelectorAll ? root : document;
  // Exit / onboarding / leave confirm must win over menu tiles behind the overlay.
  const modal =
    document.querySelector('.exit-overlay[role="dialog"]') ||
    document.querySelector('.player-leave[role="dialog"]') ||
    document.querySelector('.next-up[role="dialog"]');
  if (modal && isVisible(modal)) {
    const btn =
      modal.querySelector('.btn-primary') ||
      modal.querySelector('button:not([disabled])') ||
      null;
    if (btn && isVisible(btn)) {
      setFocused(btn, { native: false });
      return btn;
    }
  }
  const preferred =
    scope.querySelector?.('#login-user') ||
    scope.querySelector?.('.channel-list .channel') ||
    scope.querySelector?.('.excl-tile') ||
    scope.querySelector?.('.grid .tile') ||
    // While Live/VOD lists are loading, do NOT land on category chips / search.
    (document.querySelector('.state .spinner')
      ? null
      : scope.querySelector?.('.cat-chip.selected')) ||
    scope.querySelector?.('.menu-item') ||
    scope.querySelector?.('.load-more-btn') ||
    null;
  if (preferred && isVisible(preferred)) {
    setFocused(preferred, { native: false });
    return preferred;
  }
  // Last resort: skip search inputs and category chips while a list is loading.
  const loadingList = Boolean(document.querySelector('.state .spinner'));
  const list = queryFocusables(scope).filter((el) => {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return false;
    if (loadingList && el.classList?.contains('cat-chip')) return false;
    return true;
  });
  if (!list.length) return null;
  setFocused(list[0], { native: false });
  return list[0];
}

function stampTabIndex(root) {
  const scope = root && root.querySelectorAll ? root : document.body;
  if (!scope) return;
  scope.querySelectorAll(STAMP_SELECTOR).forEach((el) => {
    if (el.hasAttribute('tabindex')) return;
    if (el.disabled) return;
    el.setAttribute('tabindex', '0');
  });
}

function centerOf(rect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

export function nearest(dx, dy, fromRect, candidates) {
  const from = centerOf(fromRect);
  let best = null;
  let bestScore = Infinity;

  for (const el of candidates) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const c = centerOf(r);
    const cdx = c.x - from.x;
    const cdy = c.y - from.y;

    if (dx === 1 && r.left < fromRect.right - 4 && cdx <= 0) continue;
    if (dx === -1 && r.right > fromRect.left + 4 && cdx >= 0) continue;
    if (dy === 1 && r.top < fromRect.bottom - 4 && cdy <= 0) continue;
    if (dy === -1 && r.bottom > fromRect.top + 4 && cdy >= 0) continue;

    if (dx !== 0 && Math.abs(cdx) < 2) continue;
    if (dy !== 0 && Math.abs(cdy) < 2) continue;

    const primary = dx !== 0 ? Math.abs(cdx) : Math.abs(cdy);
    const secondary = dx !== 0 ? Math.abs(cdy) : Math.abs(cdx);
    const score = primary + secondary * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function getActiveScope(stackRef) {
  const stack = stackRef?.current;
  if (stack && stack.length) {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const entry = stack[i];
      if (entry?.trap && entry.el?.isConnected) return entry.el;
    }
  }
  return (
    document.querySelector('.app-shell') ||
    document.querySelector('.content') ||
    document.getElementById('root') ||
    document.body
  );
}

export function FocusRoot({ children }) {
  const nodes = useRef(new Map());
  const scopeStack = useRef([]);
  const rootRef = useRef(null);

  const register = useCallback((key, el) => {
    if (key && el) nodes.current.set(key, el);
  }, []);
  const unregister = useCallback((key) => {
    if (key) nodes.current.delete(key);
  }, []);

  const pushScope = useCallback((el, trap = false) => {
    if (!el) return;
    scopeStack.current = scopeStack.current.filter((n) => n.el && n.el.isConnected);
    scopeStack.current.push({ el, trap: Boolean(trap) });
  }, []);
  const popScope = useCallback((el) => {
    scopeStack.current = scopeStack.current.filter((n) => n.el !== el && n.el && n.el.isConnected);
  }, []);

  useEffect(() => {
    const root = rootRef.current || document.getElementById('root') || document.body;
    stampTabIndex(root);

    // Paint a default selection ASAP (and retry — login restore remounts late).
    const tryFocus = () => {
      const cur = getTvFocus();
      if (cur && isVisible(cur)) return;
      focusFirst(document.querySelector('.content') || root);
    };
    const timers = [0, 80, 250, 600, 1200].map((ms) => window.setTimeout(tryFocus, ms));

    const mo = new MutationObserver(() => {
      if (focusPaintLock) return;
      stampTabIndex(root);
      // If virtual target was unmounted, reclaim the SAME row by focusKey
      // (channel lists remount often). Never jump to channel #1 mid-zap.
      const cur = getTvFocus();
      if (!cur || !cur.isConnected) {
        if (lastFocusKey) {
          const safe = String(lastFocusKey).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const again = document.querySelector(`[data-focus-key="${safe}"]`);
          if (again && isVisible(again)) {
            setFocused(again, { native: false });
            return;
          }
        }
        tryFocus();
      }
    });
    mo.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'hidden'],
    });

    // Keep virtual ring in sync when mouse / touch focuses something.
    const onFocusIn = (e) => {
      if (focusPaintLock) return;
      const t = e.target;
      if (t && t !== document.body && t !== document.documentElement) {
        // Category chips only move the ring on D-pad, not when clicked to filter —
        // click would otherwise fight "focus first channel" after list remount.
        if (t.classList?.contains('cat-chip')) return;
        if (t.matches?.(FOCUSABLE_SELECTOR) || t.closest?.('[tabindex]')) {
          // During IME open, only refresh the ring — avoid extra blur cycles.
          if (isImeGuarded(t)) {
            document.querySelectorAll('.tv-focused, .focused, [data-tv-focused]').forEach((n) => {
              if (n === t) return;
              n.classList.remove('tv-focused');
              n.classList.remove('focused');
              n.removeAttribute('data-tv-focused');
            });
            currentFocused = t;
            t.classList.add('tv-focused');
            t.classList.add('focused');
            t.setAttribute('data-tv-focused', 'true');
            return;
          }
          setFocused(t, { native: false });
        }
      }
    };
    document.addEventListener('focusin', onFocusIn, true);

    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      mo.disconnect();
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, []);

  const ctx = useMemo(
    () => ({
      nodes,
      register,
      unregister,
      pushScope,
      popScope,
      scopeStack,
    }),
    [register, unregister, pushScope, popScope]
  );

  return (
    <FocusCtx.Provider value={ctx}>
      <div ref={rootRef} className="focus-root">
        {children}
      </div>
    </FocusCtx.Provider>
  );
}

export function useFocusContext() {
  return useContext(FocusCtx);
}

export function useFocusable(key, enabled = true) {
  const focusCtx = useFocusContext();
  const register = focusCtx?.register;
  const unregister = focusCtx?.unregister;
  const ref = useRef(null);
  const reactId = useId();
  const focusKey = key || reactId;

  useEffect(() => {
    if (!enabled) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    if (el.tabIndex < 0) el.tabIndex = 0;
    el.dataset.focusKey = String(focusKey);
    if (register) register(String(focusKey), el);
    return () => {
      if (unregister) unregister(String(focusKey));
    };
  }, [focusKey, enabled, register, unregister]);

  return {
    ref,
    tabIndex: enabled ? 0 : -1,
  };
}

export function FocusScope({ children, trap = true, autoFocus = true, className, as: Comp = 'div' }) {
  const ref = useRef(null);
  const ctx = useFocusContext();

  useEffect(() => {
    const el = ref.current;
    if (!el || !ctx) return undefined;
    ctx.pushScope(el, trap);
    let timer;
    if (autoFocus) {
      timer = window.setTimeout(() => focusFirst(el), 40);
    }
    return () => {
      if (timer) window.clearTimeout(timer);
      ctx.popScope(el);
    };
  }, [ctx, autoFocus, trap]);

  return (
    <Comp ref={ref} className={className} data-focus-scope={trap ? 'trap' : 'soft'}>
      {children}
    </Comp>
  );
}

export function useAutoFocus(deps = [], rootSelector) {
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const root = rootSelector
        ? document.querySelector(rootSelector)
        : document.querySelector('.content') || document.getElementById('root');
      // Always re-assert virtual focus on route change (prefer content, not topbar).
      const content = document.querySelector('.content') || root;
      focusFirst(content || root || document);
    };
    const timers = [30, 120, 400].map((ms) => window.setTimeout(run, ms));
    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function isTextBackspace(e) {
  const code = e.keyCode || e.which || 0;
  return e.key === 'Backspace' || code === 8;
}

/** LG / TV remote Back (NOT the IME delete key). */
function isRemoteBackKey(e) {
  const code = e.keyCode || e.which || 0;
  return (
    e.key === 'Escape' ||
    e.key === 'BrowserBack' ||
    e.key === 'GoBack' ||
    code === LG_BACK_KEYCODE ||
    code === 27
  );
}

function isBackKey(e) {
  // Backspace is only "Back" when we are NOT editing a text field.
  return isRemoteBackKey(e) || isTextBackspace(e);
}

function isEnterKey(e) {
  const code = e.keyCode || e.which || 0;
  return (
    e.key === 'Enter' ||
    e.key === 'Select' ||
    e.key === 'Accept' ||
    code === 13 ||
    code === DPAD_CENTER
  );
}

function arrowDirection(e) {
  const code = e.keyCode || e.which || 0;
  // Arrow keys + webOS / legacy keyCodes + some Tizen variants
  if (e.key === 'ArrowUp' || e.key === 'Up' || code === 38) return { dx: 0, dy: -1 };
  if (e.key === 'ArrowDown' || e.key === 'Down' || code === 40) return { dx: 0, dy: 1 };
  if (e.key === 'ArrowLeft' || e.key === 'Left' || code === 37) return { dx: -1, dy: 0 };
  if (e.key === 'ArrowRight' || e.key === 'Right' || code === 39) return { dx: 1, dy: 0 };
  return null;
}

/** Resolve the real editable control (input itself or nested input). */
export function resolveEditable(el) {
  if (!el) return null;
  if (el.matches?.('input, textarea, select') || el.isContentEditable) return el;
  if (el.dataset?.input === 'true' || el.getAttribute?.('data-input') === 'true') {
    return el.querySelector?.('input, textarea') || el;
  }
  return el.querySelector?.('input:not([type="hidden"]), textarea') || null;
}

/**
 * Open the platform IME on an input.
 *
 * webOS (and especially the TV simulator) often IGNORES a synchronous
 * focus()/keyboard.show() in the middle of a keydown. The keyboard then only
 * appears after the window is minimized/restored. So we:
 *  1) defer kicks until after the key event finishes
 *  2) keep a pending target and retry on window focus / visibilitychange
 */
export function openIme(el) {
  const realInput = resolveEditable(el) || (isTypingTarget(el) ? el : null);
  if (!realInput || realInput.disabled) return false;

  ensureImeListeners();
  markImeOpening(realInput, 1500);
  setFocused(realInput, { native: false });

  // Defer past the current keydown/OK — critical for webOS simulator IME.
  const delays = [0, 30, 80, 160, 320, 600];
  delays.forEach((ms) => {
    window.setTimeout(() => {
      if (pendingImeEl !== realInput) return;
      kickIme(realInput);
      if (currentFocused !== realInput) setFocused(realInput, { native: false });
    }, ms);
  });

  return true;
}

function activate(el, onEnterRef) {
  const target = el || getTvFocus();
  if (!target) return;

  const editable = resolveEditable(target) || (isTypingTarget(target) ? target : null);
  if (editable) {
    openIme(editable);
    return;
  }

  if (typeof onEnterRef.current === 'function') {
    if (typeof target.click === 'function') {
      target.click();
      return;
    }
    onEnterRef.current();
    return;
  }
  if (typeof target.click === 'function') target.click();
}

export function useGlobalTvKeys({ onEscape, onEnter } = {}) {
  const ctx = useFocusContext();
  const onEscapeRef = useRef(onEscape);
  const onEnterRef = useRef(onEnter);

  useEffect(() => {
    onEscapeRef.current = onEscape;
    onEnterRef.current = onEnter;
  }, [onEscape, onEnter]);

  useEffect(() => {
    let pendingOkInput = null;

    const handle = (e) => {
      if (e.type === 'keyup') {
        // webOS often only raises the IME after OK is released.
        if (pendingOkInput && isEnterKey(e)) {
          const el = pendingOkInput;
          pendingOkInput = null;
          openIme(el);
        }
        return;
      }

      // keydown
      if (e._tvNavHandled) return;

      // VOD/series/catchup player owns D-pad + OK (leave dialog clears this flag).
      // Live player owns CH+/− (arrows) + digits while zapping.
      // Without this, global nav steals keys from the player.
      if (
        document.documentElement.dataset.tvPlayerKeys === 'vod' ||
        document.documentElement.dataset.tvPlayerKeys === 'live'
      ) {
        const dir = arrowDirection(e);
        if (
          dir ||
          isEnterKey(e) ||
          e.key === ' ' ||
          e.key === 'MediaPlayPause' ||
          e.key === 'MediaPlay' ||
          e.key === 'MediaPause' ||
          e.key === 'MediaRewind' ||
          e.key === 'MediaFastForward' ||
          e.key === 'ChannelUp' ||
          e.key === 'ChannelDown' ||
          e.key === 'PageUp' ||
          e.key === 'PageDown' ||
          (e.key && /^[0-9]$/.test(e.key))
        ) {
          return;
        }
      }

      e._tvNavHandled = true;

      if ((e.ctrlKey || e.metaKey || e.altKey) && !isBackKey(e)) return;

      const scope = getActiveScope(ctx?.scopeStack);
      const list = queryFocusables(scope);
      let active = getTvFocus();

      if (!active || (!list.includes(active) && active.dataset?.tvSecondary !== 'true')) {
        const seed =
          list.find((el) => el.classList?.contains('channel')) ||
          list.find((el) => el.classList?.contains('menu-item')) ||
          list[0] ||
          null;
        if (seed) {
          setFocused(seed, { native: false });
          active = seed;
        }
      }

      const dir = arrowDirection(e);
      if (dir) {
        const typing = isTypingTarget(active) && document.activeElement === active;
        if (typing) {
          const leaveField =
            dir.dy !== 0 &&
            active.tagName === 'INPUT' &&
            active.type !== 'textarea';
          if (!leaveField) return;
        }
        e.preventDefault();
        e.stopPropagation();
        pendingImeEl = null;
        if (!active) {
          focusFirst(scope);
          return;
        }

        // Secondary actions live inside a row: ← returns to the row, ↑↓ jump rows.
        if (active.dataset?.tvSecondary === 'true') {
          const row = active.closest('.channel, .fav-tile, .cw-tile');
          if (dir.dx < 0 && row) {
            setFocused(row, { native: false });
            return;
          }
          if (dir.dy !== 0 && row) {
            const rows = list.filter((el) => el.classList?.contains('channel'));
            const fromRect = row.getBoundingClientRect();
            const target = nearest(0, dir.dy, fromRect, rows.filter((el) => el !== row));
            if (target) setFocused(target, { native: false });
            return;
          }
        }

        const fromRect = active.getBoundingClientRect();
        // From a channel row, → goes ONLY to Favoritos / catch-up on that row.
        if (active.classList?.contains('channel') && dir.dx > 0) {
          const secondary = secondaryFocusables(active);
          if (secondary.length) {
            setFocused(secondary[0], { native: false });
            return;
          }
        }
        const candidates = list.filter((el) => el !== active);
        // Home menu: stay inside .menu-item while any remain in that direction
        // (otherwise ↓ from Películas/Series jumps to Continuar / Favoritos).
        // Horizontal ←→ on heroes must cross columns (TV→Películas→Series), never
        // drop into Buscar/Exclusivos/Cuentas in the same column.
        let target = null;

        // Live / VOD / Series: Favoritos sits on the far left, so ↑ would score the
        // TopBar "Swiftstv" brand (also left) over the search box (wider center).
        // Always park on .search-box above the cat-bar first.
        if (!target && active.classList?.contains('cat-chip') && dir.dy < 0) {
          const searches = candidates.filter(
            (el) =>
              el.classList?.contains('search-box') ||
              (el.tagName === 'INPUT' && el.classList?.contains('search-box')),
          );
          if (searches.length) {
            target = nearest(0, -1, fromRect, searches) || searches[0];
          }
        }
        // Symmetric: ↓ from search lands on the selected (or first) category chip.
        if (
          !target &&
          dir.dy > 0 &&
          (active.classList?.contains('search-box') ||
            (active.tagName === 'INPUT' && active.classList?.contains('search-box')))
        ) {
          const chips = candidates.filter((el) => el.classList?.contains('cat-chip'));
          const selected = chips.find((el) => el.classList.contains('selected'));
          target = selected || nearest(0, 1, fromRect, chips) || chips[0] || null;
        }

        if (active.classList?.contains('menu-item')) {
          const col = active.closest('.home-col');
          const menuOnly = candidates.filter((el) => el.classList?.contains('menu-item'));
          if (dir.dy !== 0 && col) {
            const sameCol = menuOnly.filter((el) => col.contains(el));
            target = nearest(dir.dx, dir.dy, fromRect, sameCol);
          }
          if (!target && dir.dx !== 0) {
            if (active.classList.contains('menu-item--hero')) {
              const heroes = menuOnly.filter((el) => el.classList.contains('menu-item--hero'));
              target = nearest(dir.dx, 0, fromRect, heroes);
            } else if (active.classList.contains('menu-item--tool')) {
              const tools = menuOnly.filter((el) => el.classList.contains('menu-item--tool'));
              target = nearest(dir.dx, 0, fromRect, tools);
            }
          }
          if (!target) target = nearest(dir.dx, dir.dy, fromRect, menuOnly);
        }
        if (!target) target = nearest(dir.dx, dir.dy, fromRect, candidates);
        if (target) {
          const native = !isTypingTarget(target);
          setFocused(target, { native });
        }
        return;
      }

      if (isEnterKey(e)) {
        if (isTypingTarget(active) && document.activeElement === active) return;
        e.preventDefault();
        e.stopPropagation();
        const editable = resolveEditable(active) || (isTypingTarget(active) ? active : null);
        if (editable) {
          pendingOkInput = editable;
          openIme(editable);
          return;
        }
        activate(active, onEnterRef);
        return;
      }

      if (isBackKey(e) || isRemoteBackKey(e) || isTextBackspace(e)) {
        const typing = isTypingTarget(active) && document.activeElement === active;
        if (typing && isTextBackspace(e)) return;

        if (typing && isRemoteBackKey(e)) {
          e.preventDefault();
          e.stopPropagation();
          pendingImeEl = null;
          clearImeGuard();
          try {
            active.blur();
          } catch {
            /* ignore */
          }
          setFocused(active, { native: false });
          return;
        }

        if (!typing && (isRemoteBackKey(e) || isTextBackspace(e))) {
          if (typeof onEscapeRef.current === 'function') {
            e.preventDefault();
            e.stopPropagation();
            onEscapeRef.current();
          }
        }
      }
    };

    window.addEventListener('keydown', handle, true);
    window.addEventListener('keyup', handle, true);
    return () => {
      window.removeEventListener('keydown', handle, true);
      window.removeEventListener('keyup', handle, true);
    };
  }, [ctx]);
}
