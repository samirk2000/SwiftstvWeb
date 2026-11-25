import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getSession } from '../lib/session.js';
import { loadCatalogProgressive } from '../lib/catalogCache.js';
import { normalizeSearch } from '../lib/searchText.js';
import { liveStreamTsUrl } from '../lib/xtream.js';
import { setLiveZapList, setLastLiveChannel } from '../lib/liveZap.js';
import { isAdultContent } from '../lib/adult.js';
import { useFocusable } from '../components/Focusable.jsx';

const LIMIT = 24;

function ResultRow({ focusKey, label, meta, onActivate }) {
  const { ref, tabIndex } = useFocusable(focusKey);
  return (
    <button
      ref={ref}
      tabIndex={tabIndex}
      className="search-result"
      onClick={onActivate}
    >
      <span className="search-result-title">{label}</span>
      {meta ? <span className="search-result-meta">{meta}</span> : null}
    </button>
  );
}

const PART_LABEL = { live: 'search.live', vod: 'search.movies', series: 'search.series' };

export default function GlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  // Per-part state: 'loading' | 'ready' | 'error'
  const [parts, setParts] = useState({ live: 'loading', series: 'loading', vod: 'loading' });
  const [catalog, setCatalog] = useState({ live: [], vod: [], series: [] });
  const [server, setServer] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const saved = getSession();
    if (!saved) {
      navigate('/login', { replace: true });
      return undefined;
    }
    const srv = { baseUrl: saved.baseUrl, username: saved.username, password: saved.password };
    setServer(srv);
    let cancelled = false;
    setParts((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) if (next[k] !== 'ready') next[k] = 'loading';
      return next;
    });
    loadCatalogProgressive(srv, (part, items, err) => {
      if (cancelled) return;
      if (items) setCatalog((prev) => ({ ...prev, [part]: items }));
      setParts((prev) => ({ ...prev, [part]: err ? 'error' : 'ready' }));
    });
    return () => {
      cancelled = true;
    };
  }, [navigate, reloadTick]);

  // Debounce typing so a TV keyboard doesn't refilter 40k titles per letter.
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), 300);
    return () => window.clearTimeout(id);
  }, [query]);

  const q = debounced.trim();
  const results = useMemo(() => {
    if (q.length < 2) return { live: [], vod: [], series: [] };
    const needle = normalizeSearch(q);
    const pick = (list) => {
      const out = [];
      for (const it of list || []) {
        if (out.length >= LIMIT) break;
        const hay = it.n !== undefined ? it.n : normalizeSearch(it.name);
        if (hay.includes(needle) && !isAdultContent(it.name, it.category_name || '')) out.push(it);
      }
      return out;
    };
    return { live: pick(catalog.live), vod: pick(catalog.vod), series: pick(catalog.series) };
  }, [catalog, q]);

  const loadingParts = Object.keys(parts).filter((k) => parts[k] === 'loading');
  const errorParts = Object.keys(parts).filter((k) => parts[k] === 'error');
  const anyReady = Object.values(parts).some((v) => v === 'ready');
  const loading = !anyReady && loadingParts.length > 0;
  const total = results.live.length + results.vod.length + results.series.length;

  const playLive = (ch) => {
    if (!server) return;
    const list = (results.live.length ? results.live : catalog.live || [])
      .filter((c) => !isAdultContent(c.name, c.category_name || ''))
      .map((c) => ({
        id: String(c.stream_id),
        name: c.name || '',
        url: liveStreamTsUrl(server, c.stream_id),
      }));
    setLiveZapList(list);
    setLastLiveChannel(String(ch.stream_id));
    const url = liveStreamTsUrl(server, ch.stream_id);
    navigate(
      `/player?type=live&id=${ch.stream_id}&url=${encodeURIComponent(url)}&title=${encodeURIComponent(
        ch.name || ''
      )}`,
      { replace: true }
    );
  };

  return (
    <div>
      <div className="page-head">
        <button tabIndex={0} className="back-btn" onClick={() => navigate(-1)}>
          ← {t('common.back')}
        </button>
        <h1>{t('search.title')}</h1>
      </div>

      <input
        tabIndex={0}
        className="search-box"
        placeholder={t('search.placeholder')}
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className="hint">{t('search.hint')}</p>
      {loadingParts.length > 0 && !loading ? (
        <p className="hint search-status">
          <span className="spinner spinner--inline" />{' '}
          {t('search.loadingPart', loadingParts.map((p) => t(PART_LABEL[p])).join(', '))}
        </p>
      ) : null}
      {errorParts.length > 0 ? (
        <p className="hint search-status">
          {t('search.partError', errorParts.map((p) => t(PART_LABEL[p])).join(', '))}{' '}
          <button tabIndex={0} className="btn-ghost btn-xs" onClick={() => setReloadTick((x) => x + 1)}>
            {t('common.retry')}
          </button>
        </p>
      ) : null}

      {loading ? (
        <div className="state">
          <div className="spinner" />
          {t('common.loading')}
          <p className="hint">{t('search.firstTime')}</p>
        </div>
      ) : q.length < 2 ? (
        <div className="state">{t('search.typeMore')}</div>
      ) : total === 0 ? (
        <div className="state">{loadingParts.length ? t('common.loading') : t('search.noResults')}</div>
      ) : (
        <div className="search-sections">
          {results.live.length > 0 && (
            <section>
              <h2 className="row-title">{t('search.live')}</h2>
              <div className="search-list">
                {results.live.map((ch) => (
                  <ResultRow
                    key={`live-${ch.stream_id}`}
                    focusKey={`gs-live-${ch.stream_id}`}
                    label={ch.name}
                    meta={t('home.live')}
                    onActivate={() => playLive(ch)}
                  />
                ))}
              </div>
            </section>
          )}
          {results.vod.length > 0 && (
            <section>
              <h2 className="row-title">{t('search.movies')}</h2>
              <div className="search-list">
                {results.vod.map((v) => (
                  <ResultRow
                    key={`vod-${v.stream_id}`}
                    focusKey={`gs-vod-${v.stream_id}`}
                    label={v.name}
                    meta={t('home.movies')}
                    onActivate={() => navigate(`/vod/${v.stream_id}`)}
                  />
                ))}
              </div>
            </section>
          )}
          {results.series.length > 0 && (
            <section>
              <h2 className="row-title">{t('search.series')}</h2>
              <div className="search-list">
                {results.series.map((s) => (
                  <ResultRow
                    key={`series-${s.series_id}`}
                    focusKey={`gs-series-${s.series_id}`}
                    label={s.name}
                    meta={t('home.series')}
                    onActivate={() => navigate(`/series/${s.series_id}`)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
