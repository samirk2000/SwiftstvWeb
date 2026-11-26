import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getContinueWatching, getFavorites, getSession, toggleFavorite, isFavorite } from '../lib/session.js';
import { isAdultContent } from '../lib/adult.js';
import { useSession } from '../context/SessionContext.jsx';
import { useFocusable, setFocused, FocusScope } from '../components/Focusable.jsx';

// Max 2 row fetches at a time so a slow panel isn't flooded on Home.
const rowQueue = { active: 0, waiting: [] };
function queued(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      rowQueue.active += 1;
      fn()
        .then(resolve, reject)
        .finally(() => {
          rowQueue.active -= 1;
          const next = rowQueue.waiting.shift();
          if (next) next();
        });
    };
    if (rowQueue.active < 2) run();
    else rowQueue.waiting.push(run);
  });
}

function currentServer() {
  const s = getSession();
  return s?.baseUrl ? { baseUrl: s.baseUrl, username: s.username, password: s.password } : null;
}

function HeroButton({ focusKey, className, primary, onClick, children }) {
  const { ref, tabIndex } = useFocusable(focusKey);
  return (
    <button
      ref={ref}
      tabIndex={tabIndex}
      type="button"
      className={className}
      data-hero-btn="true"
      data-hero-primary={primary ? 'true' : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Big featured banner that slowly rotates through the newest titles. */
function HeroBanner({ items, onPlay, onInfo, onToggleList, listTick }) {
  const [idx, setIdx] = useState(0);
  const [backdrops, setBackdrops] = useState({});
  const rootRef = useRef(null);
  const item = items[idx % Math.max(1, items.length)];

  // Rotate every 10 s — but never while the user is on the banner's buttons.
  useEffect(() => {
    if (items.length < 2) return undefined;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      if (rootRef.current?.querySelector('.tv-focused')) return;
      setIdx((i) => (i + 1) % items.length);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [items.length]);

  // Backdrops: series lists carry one; movies need get_vod_info (cached).
  useEffect(() => {
    let alive = true;
    const srv = currentServer();
    const want = [item, items[(idx + 1) % Math.max(1, items.length)]].filter(Boolean);
    want.forEach((it) => {
      const k = `${it.kind}:${it.id}`;
      if (backdrops[k] !== undefined) return;
      if (it.backdrop) {
        setBackdrops((b) => ({ ...b, [k]: it.backdrop }));
        return;
      }
      if (it.kind !== 'vod' || !srv) {
        setBackdrops((b) => ({ ...b, [k]: '' }));
        return;
      }
      getVodInfo(srv, it.id)
        .then((res) => {
          if (!alive) return;
          const info = res?.info || {};
          const bd = firstBackdrop(info.backdrop_path);
          setBackdrops((b) => ({
            ...b,
            [k]: bd || '',
            [`${k}|genre`]: info.genre || '',
            [`${k}|plot`]: typeof info.plot === 'string' ? info.plot : '',
          }));
        })
        .catch(() => alive && setBackdrops((b) => ({ ...b, [k]: '' })));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, items]);

  if (!item) return null;
  const k = `${item.kind}:${item.id}`;
  const backdrop = backdrops[k];
  const plot = item.plot || backdrops[`${k}|plot`] || '';
  const genre = item.genre || backdrops[`${k}|genre`] || '';
  const inList = isFavorite(item.kind, item.id);
  const meta = [
    item.kind === 'series' ? t('home.heroSeries') : t('home.heroMovie'),
    item.year,
    item.rating > 0 ? `★ ${Number(item.rating).toFixed(1).replace(/\.0$/, '')}` : '',
    genre ? String(genre).split(/[,/]/)[0].trim() : '',
  ].filter(Boolean);

  return (
    <section ref={rootRef} className="home-hero" aria-roledescription="carrusel" data-list-tick={listTick}>
      <div key={k} className={`home-hero-bg ${backdrop ? '' : 'home-hero-bg--poster'}`}>
        {backdrop ? (
          <img src={backdrop} alt="" decoding="async" />
        ) : item.img ? (
          <img className="home-hero-poster" src={gridPoster(item.img)} alt="" decoding="async" />
        ) : null}
      </div>
      <div className="home-hero-shade" />
      <div key={`${k}-txt`} className="home-hero-content">
        <span className="home-hero-kicker">{t('home.featured')}</span>
        <h2 className="home-hero-title">{item.name}</h2>
        <div className="home-hero-meta">
          {meta.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
        {plot ? <p className="home-hero-plot">{plot}</p> : null}
        <div className="home-hero-actions">
          <HeroButton focusKey="hero-play" className="btn-primary btn-lg" primary onClick={() => onPlay(item)}>
            ▶ {t('vod.play')}
          </HeroButton>
          <HeroButton focusKey="hero-info" className="btn-secondary btn-lg" onClick={() => onInfo(item)}>
            ⓘ {t('home.moreInfo')}
          </HeroButton>
          <HeroButton focusKey="hero-list" className="btn-secondary btn-lg" onClick={() => onToggleList(item)}>
            {inList ? `✓ ${t('home.inMyList')}` : `+ ${t('home.myList')}`}
          </HeroButton>
        </div>
      </div>
      {items.length > 1 ? (
        <div className="home-hero-dots" aria-hidden="true">
          {items.map((it, i) => (
            <span key={`${it.kind}-${it.id}`} className={i === idx % items.length ? 'on' : ''} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** One lazily loaded row of posters (fetches when it scrolls near the screen). */
function LazyRow({ row, eager, onItems, onOpen }) {
  const ref = useRef(null);
  const [items, setItems] = useState(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(Boolean(eager));

  useEffect(() => {
    if (visible) return undefined;
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') {
      const id = window.setTimeout(() => setVisible(true), 1500);
      return () => window.clearTimeout(id);
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '500px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    const srv = currentServer();
    if (!srv) return undefined;
    queued(() => loadRowItems(srv, row))
      .then((list) => {
        if (!alive) return;
        setItems(list);
        if (onItems) onItems(row, list);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, row.key]);

  if (failed || (items && !items.length)) return null;
  return (
    <section ref={ref} className="row home-row">
      <h2 className="row-title">{row.title}</h2>
      {!items ? (
        <SkeletonRow poster />
      ) : (
        <div className="row-scroll">
          {items.map((it) => (
            <Tile
              key={`${it.kind}-${it.id}`}
              focusKey={`row-${row.key}-${it.id}`}
              title={it.name}
              poster={gridPoster(it.img)}
              aspect="2/3"
              className="poster"
              onActivate={() => onOpen(it)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
import { Row, Tile, SkeletonRow } from '../components/ui.jsx';
import { loadHomePlan, loadRowItems } from '../lib/homeRows.js';
import { getVodInfo, vodStreamUrl } from '../lib/xtream.js';
import { isCategoryLocked } from '../lib/parental.js';
import { gridPoster, firstBackdrop } from '../lib/text.js';
import { getPrefs, setPrefs } from '../lib/prefs.js';
import { formatExpiry, daysUntil } from '../lib/time.js';
import { prefetchCatalog } from '../lib/catalogCache.js';
import RenewDialog from '../components/RenewDialog.jsx';
import { renewState, renewDismissedToday, dismissRenewToday } from '../lib/renew.js';

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
  if (days <= 7) return t('expiry.soonDays', label || String(raw), t('expiry.left', daysUntil(raw) ?? 0));
  return '';
}

export default function Home() {
  const navigate = useNavigate();
  const { session, langTick } = useSession();
  const [tick, setTick] = useState(0);
  const [showTips, setShowTips] = useState(() => !getPrefs().onboardingDone);
  const [plan, setPlan] = useState([]);
  const [heroItems, setHeroItems] = useState([]);
  const saved = getSession();
  const expiryMsg = expiryBannerText(saved?.user_info || session?.info || session?.session?.user_info);
  const userInfo = saved?.user_info || session?.info || session?.session?.user_info;
  const renewUser = saved?.username || userInfo?.username || '';
  const renew = renewState(userInfo);
  const [renewOpen, setRenewOpen] = useState(false);
  // Pop the reminder once per day (after the onboarding tips, if any).
  useEffect(() => {
    if (!renew || showTips || renewDismissedToday(renewUser)) return undefined;
    const id = window.setTimeout(() => setRenewOpen(true), 1200);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(renew), showTips, renewUser]);
  const closeRenew = () => {
    dismissRenewToday(renewUser);
    setRenewOpen(false);
  };

  useEffect(() => {
    setTick((x) => x + 1);
  }, []);

  // Warm live + series catalogs for Buscar while the user is on Home.
  useEffect(() => {
    const id = window.setTimeout(() => {
      const s = getSession();
      if (s?.baseUrl) prefetchCatalog({ baseUrl: s.baseUrl, username: s.username, password: s.password });
    }, 15000); // after the first rows, so slow panels aren't flooded
    return () => window.clearTimeout(id);
  }, []);

  // Which rows to show (two small category calls, cached 3 h).
  useEffect(() => {
    let alive = true;
    const srv = currentServer();
    if (!srv) return undefined;
    loadHomePlan(srv)
      .then((rows) => alive && setPlan(rows || []))
      .catch(() => alive && setPlan([]));
    return () => {
      alive = false;
    };
  }, [session]);

  // Kids / parental: hide locked categories immediately (plan is cached).
  const visiblePlan = useMemo(
    () => plan.filter((r) => !isCategoryLocked(r.catId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan, tick],
  );

  const onRowItems = useCallback((row, list) => {
    setHeroItems((prev) => {
      if (prev.length >= 6) return prev;
      const have = new Set(prev.map((x) => `${x.kind}:${x.id}`));
      const extra = list.filter((x) => x.img && x.plot && !have.has(`${x.kind}:${x.id}`)).slice(0, 6 - prev.length);
      return extra.length ? [...prev, ...extra] : prev;
    });
  }, []);

  const continueRow = useMemo(() => {
    const list = getContinueWatching();
    const base = getSession()?.baseUrl;
    const seenSeries = new Set();
    const out = [];
    for (const c of list) {
      // One card per series (its latest episode), like Netflix.
      if (c.type === 'series' && c.seriesId) {
        if (seenSeries.has(String(c.seriesId))) continue;
        seenSeries.add(String(c.seriesId));
      }
      out.push({ ...c, image: c.image || undefined, baseUrl: c.baseUrl || base, url: c.url || '' });
      if (out.length >= 12) break;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, tick, langTick]);

  const favorites = useMemo(
    () => getFavorites().filter((f) => !isAdultContent(f.title, f.categoryName)).slice(0, 40),
    // session: re-read when switching accounts so rails never leak across users
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, tick, langTick],
  );
  const myList = favorites.filter((f) => f.type === 'vod' || f.type === 'series');
  const favChannels = favorites.filter((f) => f.type === 'live');

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

  const openItem = (it) => navigate(it.kind === 'series' ? `/series/${it.id}` : `/vod/${it.id}`);
  const playItem = (it) => {
    if (it.kind === 'series') {
      navigate(`/series/${it.id}?autoplay=1`);
      return;
    }
    const srv = currentServer();
    if (!srv) return;
    const qs = new URLSearchParams({
      type: 'vod',
      id: String(it.id),
      url: vodStreamUrl(srv, it.id, it.ext || 'mp4'),
      title: it.name || '',
    });
    if (it.img) qs.set('image', it.img);
    navigate(`/player?${qs.toString()}`);
  };
  const toggleList = (it) => {
    toggleFavorite({
      type: it.kind,
      id: it.id,
      title: it.name,
      image: it.img || '',
      categoryId: it.cat || '',
      categoryName: it.catName || '',
    });
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
    if (c.image) qs.set('image', c.image);
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
      {renew ? (
        <div className="expiry-banner expiry-banner--renew">
          <span>
            {renew.expired ? t('renew.expired') : renew.days <= 0 ? t('renew.today') : t('renew.inDays', renew.days)}
            {renew.date ? ` · ${renew.date}` : ''}
          </span>
          <button tabIndex={0} className="btn-secondary btn-xs renew-open-btn" onClick={() => setRenewOpen(true)}>
            {t('renew.whatsapp')}
          </button>
        </div>
      ) : expiryMsg ? (
        <div className="expiry-banner">{expiryMsg}</div>
      ) : null}
      <RenewDialog open={renewOpen} state={renew} username={renewUser} onClose={closeRenew} />

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

        {heroItems.length ? (
          <HeroBanner
            items={heroItems}
            onPlay={playItem}
            onInfo={openItem}
            onToggleList={toggleList}
            listTick={tick}
          />
        ) : visiblePlan.length ? (
          <div className="home-hero home-hero--skeleton" aria-hidden="true" />
        ) : null}

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
                  progress={c.duration > 0 ? (c.position || 0) / c.duration : undefined}
                  onActivate={() => openContinue(c)}
                />
              </div>
            )}
          />
        )}

        {myList.length > 0 && (
          <Row
            title={t('home.myList')}
            items={myList}
            itemKey={(f) => `${f.type}-${f.id}`}
            renderItem={(f) => (
              <div className="fav-tile" key={`${f.type}-${f.id}`}>
                <Tile
                  focusKey={`fav-${f.type}-${f.id}`}
                  title={f.title}
                  poster={gridPoster(f.image)}
                  aspect="2/3"
                  className="poster"
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

        {visiblePlan.map((row, i) => (
          <LazyRow key={row.key} row={row} eager={i < 2} onItems={onRowItems} onOpen={openItem} />
        ))}

        {favChannels.length > 0 && (
          <Row
            title={t('home.favChannels')}
            items={favChannels}
            itemKey={(f) => `${f.type}-${f.id}`}
            renderItem={(f) => (
              <div className="fav-tile" key={`${f.type}-${f.id}`}>
                <Tile
                  focusKey={`fav-${f.type}-${f.id}`}
                  title={f.title}
                  poster={f.image}
                  aspect="16/9"
                  className="tile--channel"
                  onActivate={() => toFavorite(f)}
                />
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}
