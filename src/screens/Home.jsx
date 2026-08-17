import { useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getContinueWatching, getSession } from '../lib/session.js';
import { useSession } from '../context/SessionContext.jsx';
import { useFocusable } from '../components/Focusable.jsx';
import { Row, Tile } from '../components/ui.jsx';

function MenuItem({ to, icon, label, onNavigate, focusRef }) {
  const { ref, tabIndex } = useFocusable(`menu-${to}`);
  return (
    <button
      ref={(el) => {
        ref.current = el;
        if (focusRef) focusRef.current = el;
      }}
      tabIndex={tabIndex}
      className="menu-item"
      onClick={onNavigate}
    >
      <span className="icon">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { session } = useSession();
  const firstRef = useRef(null);
  const didInitFocus = useRef(false);

  // On first mount (and whenever returning to home with a fresh focus), focus
  // the Live tile so the remote/D-pad has an immediate target instead of a
  // seemingly-empty screen.
  useEffect(() => {
    if (didInitFocus.current) return;
    didInitFocus.current = true;
    const t = setTimeout(() => {
      firstRef.current?.focus();
    }, 60);
    return () => clearTimeout(t);
  }, []);

  const continueRow = useMemo(() => {
    const list = getContinueWatching();
    const base = getSession()?.baseUrl;
    return list.slice(0, 12).map((c) => ({
      ...c,
      image: c.image || undefined,
      baseUrl: c.baseUrl || base,
    }));
  }, [session]);

  const go = (path) => navigate(path);

  return (
    <div>
      <div className="menu-grid">
        <MenuItem focusRef={firstRef} to="live" icon="📺" label={t('home.live')} onNavigate={() => go('/live')} />
        <MenuItem to="movies" icon="🎬" label={t('home.movies')} onNavigate={() => go('/vod')} />
        <MenuItem to="series" icon="📚" label={t('home.series')} onNavigate={() => go('/series')} />
        <MenuItem to="exclusivos" icon="⚡" label={t('home.exclusivos')} onNavigate={() => go('/exclusivos')} />
      </div>

      {continueRow.length > 0 && (
        <Row
          title={t('home.continueWatching')}
          items={continueRow}
          itemKey={(c) => `${c.type}-${c.id}`}
          renderItem={(c) => (
            <Tile
              key={`${c.type}-${c.id}`}
              title={c.title}
              poster={c.image}
              aspect="16/9"
              onActivate={() => navigate(`/player?type=${c.type}&id=${c.id}`)}
            />
          )}
        />
      )}
    </div>
  );
}
