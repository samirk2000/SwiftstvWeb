import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { subscribeActivity } from '../lib/netActivity.js';

// What the app is downloading right now, as a small non-focusable pill:
//  - foreground (the user is waiting): "Descargando canales… 40%" / "… 3,2 MB"
//  - background search index:          "Preparando catálogo… 35%"
// Never shown in the player; never takes focus or clicks.
const SHOW_AFTER_MS = 700; // don't flash for quick requests

function mb(bytes) {
  return (bytes / (1024 * 1024)).toLocaleString('es-MX', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
}

export default function ActivityIndicator() {
  const { pathname } = useLocation();
  const [snap, setSnap] = useState(null);
  const [fgVisible, setFgVisible] = useState(false);

  useEffect(() => subscribeActivity(setSnap), []);

  // Only what THIS screen is waiting for (largest known download first).
  const mine = snap ? snap.fgList.filter((v) => v.route === pathname && v.kind !== 'epg') : [];
  mine.sort((a, b) => (b.total ? 1 : 0) - (a.total ? 1 : 0));
  const fgNow = mine[0] || null;
  const fgKey = fgNow ? `${fgNow.kind}:${pathname}` : '';
  useEffect(() => {
    setFgVisible(false);
    if (!fgKey) return undefined;
    const id = window.setTimeout(() => setFgVisible(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [fgKey]);

  if (!snap || pathname.startsWith('/player') || pathname.startsWith('/login')) return null;

  let text = '';
  let pct = null;
  const fg = fgNow;
  if (fg && fgVisible) {
    const label = t(`activity.${fg.kind}`) || t('activity.catalog');
    if (fg.total > 0) {
      pct = Math.min(99, Math.round((fg.loaded / fg.total) * 100));
      text = `${label} ${pct}%`;
    } else if (fg.loaded > 256 * 1024) {
      text = `${label} ${mb(fg.loaded)} MB`;
    } else text = label;
  } else if (!fg && !snap.fgCount && snap.bg && snap.bg.total > 0) {
    pct = Math.min(99, Math.round((snap.bg.done / snap.bg.total) * 100));
    text = `${t('activity.preparing')} ${pct}%`;
  }
  if (!text) return null;

  return (
    <div className={`activity-pill${fg ? ' activity-pill--fg' : ''}`} role="status" aria-live="polite">
      <span className="activity-dot" aria-hidden="true" />
      <span>{text}</span>
      {pct !== null ? (
        <span className="activity-bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      ) : null}
    </div>
  );
}
