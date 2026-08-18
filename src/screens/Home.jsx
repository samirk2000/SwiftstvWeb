import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getContinueWatching, getFavorites, getSession } from '../lib/session.js';
import { useSession } from '../context/SessionContext.jsx';
import { useFocusable } from '../components/Focusable.jsx';
import { Row, Tile } from '../components/ui.jsx';

function MenuItem({ to, icon, label, onNavigate, focus = false }) {
  const { ref, tabIndex } = useFocusable(`menu-${to}`);
  return (
    <button
      ref={ref}
      tabIndex={tabIndex}
      className="menu-item"
      onClick={onNavigate}
      autoFocus={focus || undefined}
    >
      <span className="icon">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { session, langTick } = useSession();
  // Bumped when we re-enter Home so continue-watching / favorites reflect the
  // position/state saved by the player and detail screens.
  const [tick, setTick] = useState(0);

  const continueRow = useMemo(() => {
    const list = getContinueWatching();
    const base = getSession()?.baseUrl;
    return list.slice(0, 12).map((c) => ({
      ...c,
      image: c.image || undefined,
      baseUrl: c.baseUrl || base,
      url: c.url || '',
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, tick, langTick]);

  const favorites = useMemo(() => getFavorites().slice(0, 24), [tick, langTick]);

  const go = (path) => navigate(path);
  const toFavorite = (f) => {
    if (f.type === 'vod') navigate(`/vod/${f.id}`);
    else if (f.type === 'series') navigate(`/series/${f.id}`);
    else if (f.type === 'live') navigate('/live');
    else navigate('/');
  };

  const openContinue = (c) => {
    const qs = new URLSearchParams();
    qs.set('type', c.type);
    qs.set('id', c.id);
    if (c.position) qs.set('start', c.position);
    if (c.title) qs.set('title', c.title);
    if (c.url) qs.set('url', c.url);
    navigate(`/player?${qs.toString()}`);
  };

  return (
    <div onFocus={() => setTick((x) => x + 1)}>
      <div className="menu-grid">
        <MenuItem focus to="live" icon="📺" label={t('home.live')} onNavigate={() => go('/live')} />
        <MenuItem to="movies" icon="🎬" label={t('home.movies')} onNavigate={() => go('/vod')} />
        <MenuItem to="series" icon="📚" label={t('home.series')} onNavigate={() => go('/series')} />
        <MenuItem to="exclusivos" icon="⚡" label={t('home.exclusivos')} onNavigate={() => go('/exclusivos')} />
        <MenuItem to="parental" icon="🔒" label={t('home.parental')} onNavigate={() => go('/parental')} />
      </div>

      {continueRow.length > 0 && (
        <Row
          title={t('home.continueWatching')}
          items={continueRow}
          itemKey={(c) => `${c.type}-${c.id}`}
          renderItem={(c) => (
            <div className="cw-tile" key={`${c.type}-${c.id}`}>
              <Tile title={c.title} poster={c.image} aspect="16/9" onActivate={() => openContinue(c)} />
              <button className="btn-ghost btn-xs btn-resume" onClick={() => openContinue(c)}>
                ▶ {t('home.resume')}
              </button>
            </div>
          )}
        />
      )}

      {favorites.length > 0 && (
        <Row
          title={t('home.favorites')}
          items={favorites}
          itemKey={(f) => `${f.type}-${f.id}`}
          renderItem={(f) => (
            <Tile
              key={`${f.type}-${f.id}`}
              title={f.title}
              poster={f.image}
              aspect="2/3"
              onActivate={() => toFavorite(f)}
            />
          )}
        />
      )}
    </div>
  );
}
