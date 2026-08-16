// Lightweight TV focus model without any dependency.
//
// We use real DOM focus targets + spatial navigation. A single app-level
// handler (useGlobalTvKeys) drives arrow-key / D-pad movement between
// registered nodes and Enter / OK activation. Robust across LG/Samsung/Sony/
// HISENSE browser engines. Text inputs are excluded from spatial nav while
// focused so typing works on Login.

import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

const FocusCtx = createContext(null);

export function FocusRoot({ children }) {
  const nodes = useRef(new Map());
  const [enabled, setEnabled] = useState(true);

  const register = useCallback((key, el) => {
    nodes.current.set(key, el);
  }, []);
  const unregister = useCallback((key) => {
    nodes.current.delete(key);
  }, []);

  const ctx = useMemo(
    () => ({ nodes: nodes.current, enabled }),
    [enabled]
  );

  return <FocusCtx.Provider value={ctx}>{children}</FocusCtx.Provider>;
}

export function useFocusContext() {
  return useContext(FocusCtx);
}

function isTypingTarget(el) {
  return (
    el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable)
  );
}

// Spatial navigation: find the best candidate in the requested direction.
function nearest(dx, dy, fromRect, candidateEls) {
  let best = null;
  let bestScore = Infinity;
  for (const el of candidateEls) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const fromCx = fromRect.left + fromRect.width / 2;
    const fromCy = fromRect.top + fromRect.height / 2;
    const cdx = r.left + r.width / 2 - fromCx;
    const cdy = r.top + r.height / 2 - fromCy;

    if (dx === 1 && cdx <= 0) continue;
    if (dx === -1 && cdx >= 0) continue;
    if (dy === 1 && cdy <= 0) continue;
    if (dy === -1 && cdy >= 0) continue;

    const perpendicular =
      dx !== 0 ? Math.abs(r.top + r.height / 2 - fromCy) : Math.abs(r.left + r.width / 2 - fromCx);
    const dist = Math.hypot(cdx, cdy) + perpendicular * 2;
    if (dist < bestScore) {
      bestScore = dist;
      best = el;
    }
  }
  return best;
}

// Register an element as a nav target. A single disabled element prevents auto
// focus while typing but stays out of the movement ring.
export function useFocusable(key, enabled = true) {
  const { register, unregister, enabled: ringEnabled } = useFocusContext();
  const ref = useRef(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    const k = key || el.id || null;
    if (!k) return undefined;
    el.dataset.focusKey = k;
    register(k, el);
    return () => unregister(k);
  }, [key, enabled, register, unregister, ringEnabled]);

  return {
    ref,
    tabIndex: enabled ? 0 : -1,
  };
}

// Global key handling for arrows + Enter + Escape. Attach once at the app root.
export function useGlobalTvKeys({ onEscape, onEnter }) {
  const { nodes } = useFocusContext();
  const onEscapeRef = useRef(onEscape);
  const onEnterRef = useRef(onEnter);

  useEffect(() => {
    onEscapeRef.current = onEscape;
    onEnterRef.current = onEnter;
  }, [onEscape, onEnter]);

  const moveRef = useRef({ dx: 0, dy: 0 });
  moveRef.current = { dx: 0, dy: 0 };

  const navigate = useCallback(
    (dx, dy) => {
      const from = document.activeElement;
      if (!from) return;
      if (isTypingTarget(from)) return; // let text fields keep their arrows
      const rect = from.getBoundingClientRect();
      const target = nearest(dx, dy, rect, nodes.current.values());
      if (!target) return;
      target.focus();
      target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    },
    [nodes]
  );

  const activate = useCallback(() => {
    const el = document.activeElement;
    if (el && !isTypingTarget(el) && typeof el.click === 'function') {
      el.click();
    } else if (typeof onEnterRef.current === 'function') {
      onEnterRef.current();
    }
  }, []);

  useEffect(() => {
    const handler = (e) => {
      const target = document.activeElement;
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          navigate(0, -1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          navigate(0, 1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          navigate(-1, 0);
          break;
        case 'ArrowRight':
          e.preventDefault();
          navigate(1, 0);
          break;
        case 'Enter':
          if (isTypingTarget(target)) return; // native form submit
          e.preventDefault();
          if (typeof onEnterRef.current === 'function') {
            onEnterRef.current();
          } else {
            activate();
          }
          break;
        case 'Escape':
        case 'Backspace':
          if (isTypingTarget(target)) {
            target.blur();
            e.preventDefault();
          } else if (typeof onEscapeRef.current === 'function') {
            e.preventDefault();
            onEscapeRef.current();
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, activate]);

  return { navigate, activate };
}
