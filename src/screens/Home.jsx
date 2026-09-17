import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getContinueWatching, getFavorites, getSession, toggleFavorite } from '../lib/session.js';
import { isAdultContent } from '../lib/adult.js';
import { useSession } from '../context/SessionContext.jsx';
import { useFocusable, setFocused, FocusScope } from '../components/Focusable.jsx';
import { Row, Tile } from '../components/ui.jsx';
import { getPrefs, setPrefs } from '../lib/prefs.js';
import { formatExpiry } from '../lib/time.js';

function OnboardingTips({ onDismiss }) {
  const ok = useFocusable('onboarding-ok');

  useEffect(() => {
    const timers = [50, 150, 450].map((ms) =>
      window.setTimeout(() => setFocused(ok.ref.current, { native: false }), ms),
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [ok.ref]);

  return (
    <div className="exit-overlay onboarding-overlay" role="dialog" aria-modal="true">
      <FocusScope trap autoFocus className="exit-dialog">
        <h2>{t('onboarding.title')}</h2>
        <p>{t('onboarding.body')}</p>
        <div className="exit-actions">
          <button
            ref={ok.ref}
            tabIndex={0}
            className="btn-primary"
            data-focusable="true"
            data-focus-key="onboarding-ok"
            onClick={onDismiss}
          >
            {t('onboarding.gotIt')}
          </button>
        </div>
      </FocusScope>
    </div>
  );
}

function MenuItem({ to, iconSrc, label, onNavigate, focus = false, hero = false, tone = '' }) {
  const { ref, tabIndex } = useFocusable(`menu-${to}`);
  return (
    <button
      ref={ref}
      tabIndex={tabIndex}
      className={`menu-item ${hero ? 'menu-item--hero' : 'menu-item--tool'} ${
        tone ? `menu-item--${tone}` : ''
      }`}
      onClick={onNavigate}
      autoFocus={focus || undefined}
    >
      <span className="icon" aria-hidden="true">
        <img className="menu-icon-img" src={iconSrc} alt="" draggable={false} />
      </span>
      <span className="menu-item-label">{label}</span>
    </button>
  );
}

function expiryBannerText(userInfo) {
  if (!userInfo) return '';
  const raw = userInfo.exp_date;
  if (!raw || raw === '0') return '';
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n * 1000;
  const days = (ms - Date.now()) / (1000 * 60 * 60 * 24);
  const label = formatExpiry(raw);
  if (days < 0) return t('expiry.expired');
  if (days <= 7) return t('expiry.soon', label || String(raw));
  return '';
}

export default function Home() {
  const navigate = useNavigate();
  const { session, langTick } = useSession();
  const [tick, setTick] = useState(0);
  const [showTips, setShowTips] = useState(() => !getPrefs().onboardingDone);
  const saved = getSession();
  const expiryMsg = expiryBannerText(saved?.user_info || session?.info || session?.session?.user_info);

  useEffect(() => {
    setTick((x) => x + 1);
  }, []);

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

  const favorites = useMemo(
    () => getFavorites().filter((f) => !isAdultContent(f.title, f.categoryName)).slice(0, 24),
    [tick, langTick],
  );

  const go = (path) => navigate(path);
  const toFavorite = (f) => {
    if (f.type === 'vod') navigate(`/vod/${f.id}`);
    else if (f.type === 'series') navigate(`/series/${f.id}`);
    else if (f.type === 'live') navigate('/live');
    else navigate('/');
  };
  const removeFavorite = (f) => {
    toggleFavorite({ type: f.type, id: f.id, title: f.title, image: f.image });
    setTick((x) => x + 1);
  };

  const openContinue = (c) => {
    const qs = new URLSearchParams();
    qs.set('type', c.type);
    qs.set('id', c.id);
    if (c.position) qs.set('start', c.position);
    if (c.title) qs.set('title', c.title);
    if (c.url) qs.set('url', c.url);
    if (c.seriesId) qs.set('seriesId', c.seriesId);
    if (c.season) qs.set('season', c.season);
    navigate(`/player?${qs.toString()}`);
  };

  const dismissTips = () => {
    setPrefs({ onboardingDone: true });
    setShowTips(false);
    window.setTimeout(() => {
      const first =
        document.querySelector('.home-col .menu-item--hero') ||
        document.querySelector('.menu-item');
      if (first) setFocused(first, { native: false });
    }, 40);
  };

  return (
    <div>
      {expiryMsg ? <div className="expiry-banner">{expiryMsg}</div> : null}

      {showTips ? <OnboardingTips onDismiss={dismissTips} /> : null}

      <div
        className="home-main"
        aria-hidden={showTips ? 'true' : undefined}
        style={showTips ? { pointerEvents: 'none', visibility: 'hidden' } : undefined}
      >
        {/* 3 columns so ↓ from TV/Películas/Series lands on tools, not Continuar. */}
        <div className="home-columns">
          <div className="home-col">
            <MenuItem
              focus={!showTips}
              to="live"
              iconSrc="/brand/icon-live.png"
              label={t('home.live')}
              hero
              tone="live"
              onNavigate={() => go('/live')}
            />
            <div className="home-col-tools">
              <MenuItem
                to="search"
                iconSrc="/brand/icon-search.png"
                label={t('home.search')}
                onNavigate={() => go('/search')}
              />
              <MenuItem
                to="exclusivos"
                iconSrc="/brand/icon-exclusivos.png"
                label={t('home.exclusivos')}
                onNavigate={() => go('/exclusivos')}
              />
            </div>
          </div>
          <div className="home-col">
            <MenuItem
              to="movies"
              iconSrc="/brand/icon-movies.png"
              label={t('home.movies')}
              hero
              tone="movies"
              onNavigate={() => go('/vod')}
            />
            <div className="home-col-tools">
              <MenuItem
                to="parental"
                iconSrc="/brand/icon-parental.png"
                label={t('home.parental')}
                onNavigate={() => go('/parental')}
              />
              <MenuItem
                to="accounts"
                iconSrc="/brand/icon-accounts.png"
                label={t('home.accounts')}
                onNavigate={() => go('/accounts')}
              />
            </div>
          </div>
          <div className="home-col">
            <MenuItem
              to="series"
              iconSrc="/brand/icon-series.png"
              label={t('home.series')}
              hero
              tone="series"
              onNavigate={() => go('/series')}
            />
            <div className="home-col-tools">
              <MenuItem
                to="settings"
                iconSrc="/brand/icon-settings.png"
                label={t('home.settings')}
                onNavigate={() => go('/settings')}
              />
            </div>
          </div>
        </div>

        {continueRow.length > 0 && (
          <Row
            title={t('home.continueWatching')}
            items={continueRow}
            itemKey={(c) => `${c.type}-${c.id}`}
            renderItem={(c) => (
              <div className="cw-tile" key={`${c.type}-${c.id}`}>
                <Tile
                  focusKey={`cw-${c.type}-${c.id}`}
                  title={c.title}
                  poster={c.image}
                  aspect="16/9"
                  onActivate={() => openContinue(c)}
                />
                <button
                  type="button"
                  tabIndex={0}
                  data-tv-secondary="true"
                  className="btn-ghost btn-xs btn-resume"
                  onClick={() => openContinue(c)}
                >
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
              <div className="fav-tile" key={`${f.type}-${f.id}`}>
                <Tile
                  focusKey={`fav-${f.type}-${f.id}`}
                  title={f.title}
                  poster={f.image}
                  aspect="2/3"
                  onActivate={() => toFavorite(f)}
                />
                <button
                  type="button"
                  tabIndex={0}
                  data-tv-secondary="true"
                  className="btn-ghost btn-xs fav-btn fa tile-fav"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFavorite(f);
                  }}
                  title={t('common.unfavorite')}
                >
                  ★
                </button>
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}
