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
    out.push(el);
  }
  return out;
}

/**
 * ONLY entry point that paints the cyan ring. Clears every previous marker first
 * so Username + Password can never both show tv-focused at once.
 */
export function setFocused(newEl, opts = {}) {
  const native = opts.native === true; // default false — caller opts in for IME

  document.querySelectorAll('.tv-focused, .focused, [data-tv-focused]').forEach((e) => {
    e.classList.remove('tv-focused');
    e.classList.remove('focused');
    e.removeAttribute('data-tv-focused');
  });

  currentFocused = null;

  if (!newEl || !newEl.isConnected) {
    // eslint-disable-next-line no-console
    console.log('[Focus] -> (none)');
    return false;
  }

  newEl.classList.add('tv-focused');
  newEl.classList.add('focused');
  newEl.setAttribute('data-tv-focused', 'true');
  currentFocused = newEl;

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

  return true;
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

/** Prefer main content controls over the topbar brand on first paint. */
export function focusFirst(root) {
  const scope = root && root.querySelectorAll ? root : document;
  const preferred =
    scope.querySelector?.('#login-user') ||
    scope.querySelector?.('.menu-item') ||
    scope.querySelector?.('.content button, .content [tabindex="0"], .content input') ||
    null;
  if (preferred && isVisible(preferred)) {
    setFocused(preferred, { native: false });
    return preferred;
  }
  const list = queryFocusables(scope);
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
      stampTabIndex(root);
      // If virtual target was unmounted, pick a new one.
      if (!getTvFocus()) tryFocus();
    });
    mo.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'hidden'],
    });

    // Keep virtual ring in sync when mouse / touch focuses something.
    const onFocusIn = (e) => {
      const t = e.target;
      if (t && t !== document.body && t !== document.documentElement) {
        if (t.matches?.(FOCUSABLE_SELECTOR) || t.closest?.('[tabindex]')) {
          // Re-enter through setFocused so we never stack cyan rings.
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

function isBackKey(e) {
  const code = e.keyCode || e.which || 0;
  return (
    e.key === 'Escape' ||
    e.key === 'Backspace' ||
    e.key === 'BrowserBack' ||
    e.key === 'GoBack' ||
    code === LG_BACK_KEYCODE ||
    code === 27 ||
    code === 8
  );
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
 * Open the platform IME on an input. webOS needs a real DOM focus() (and often
 * a synthetic click); virtual tv-focused alone is not enough.
 */
export function openIme(el) {
  const realInput = resolveEditable(el) || (isTypingTarget(el) ? el : null);
  if (!realInput || realInput.disabled || realInput.readOnly) return false;

  // Single cyan ring on the editable, then native focus to open the keyboard.
  setFocused(realInput, { native: false });

  try {
    realInput.focus();
  } catch {
    try {
      realInput.focus({ preventScroll: false });
    } catch {
      /* continue with click / webOS API */
    }
  }

  // Re-assert ring after focus (focusin also calls setFocused).
  setFocused(realInput, { native: false });

  try {
    if (typeof realInput.click === 'function') realInput.click();
  } catch {
    /* ignore */
  }

  try {
    realInput.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
    );
  } catch {
    /* ignore */
  }

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

  return document.activeElement === realInput || realInput === getTvFocus();
}

function activate(el, onEnterRef) {
  const target = el || getTvFocus();
  if (!target) return;

  // OK on an input / data-input host → open native IME (do not skip / click past it).
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
    const handle = (e) => {
      // Only react once per physical key (keydown). Ignore repeats from keyup
      // listeners or bubbled duplicates.
      if (e.type !== 'keydown') return;
      if (e._tvNavHandled) return;
      e._tvNavHandled = true;

      if ((e.ctrlKey || e.metaKey || e.altKey) && !isBackKey(e)) return;

      const scope = getActiveScope(ctx?.scopeStack);
      const list = queryFocusables(scope);
      let active = getTvFocus();

      // No painted selection yet → put one on the first control BEFORE moving.
      if (!active || !list.includes(active)) {
        const seed =
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
        // Single-line inputs: Left/Right keep caret; Up/Down leave the field
        // (TV IME closed or still focused — otherwise Login gets stuck).
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
        if (!active) {
          focusFirst(scope);
          return;
        }
        const fromRect = active.getBoundingClientRect();
        const candidates = list.filter((el) => el !== active);
        const target = nearest(dir.dx, dir.dy, fromRect, candidates);
        if (target) {
          // Don't native-focus inputs on arrow (reopens webOS IME). OK opens it.
          const native = !isTypingTarget(target);
          setFocused(target, { native });
        }
        return;
      }

      if (isEnterKey(e)) {
        // Already typing in the IME — let the key reach the input / form.
        if (isTypingTarget(active) && document.activeElement === active) return;
        e.preventDefault();
        e.stopPropagation();
        activate(active, onEnterRef);
        return;
      }

      if (isBackKey(e)) {
        if (isTypingTarget(active) && document.activeElement === active) {
          e.preventDefault();
          e.stopPropagation();
          try {
            active.blur();
          } catch {
            /* ignore */
          }
          // Stay on the same field that had the IME — never yank to #login-user.
          setFocused(active, { native: false });
          return;
        }
        if (typeof onEscapeRef.current === 'function') {
          e.preventDefault();
          e.stopPropagation();
          onEscapeRef.current();
        }
      }
    };

    window.addEventListener('keydown', handle, true);
    return () => {
      window.removeEventListener('keydown', handle, true);
    };
  }, [ctx]);
}
