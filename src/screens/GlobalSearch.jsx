import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getSession } from '../lib/session.js';
import { loadCatalog } from '../lib/catalogCache.js';
import { matchesSearch } from '../lib/searchText.js';
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

export default function GlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState({ live: [], vod: [], series: [] });
  const [server, setServer] = useState(null);

  useEffect(() => {
    const saved = getSession();
    if (!saved) {
      navigate('/login', { replace: true });
      return;
    }
    const srv = { baseUrl: saved.baseUrl, username: saved.username, password: saved.password };
    setServer(srv);
    let cancelled = false;
    (async () => {
      setLoading(true);
      const data = await loadCatalog(srv);
      if (!cancelled) {
        setCatalog(data);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const q = query.trim();
  const results = useMemo(() => {
    if (q.length < 2) return { live: [], vod: [], series: [] };
    const live = (catalog.live || [])
      .filter((c) => matchesSearch(c.name, q) && !isAdultContent(c.name, c.category_name || ''))
      .slice(0, LIMIT);
    const vod = (catalog.vod || [])
      .filter((v) => matchesSearch(v.name, q) && !isAdultContent(v.name, v.category_name || ''))
      .slice(0, LIMIT);
    const series = (catalog.series || [])
      .filter((s) => matchesSearch(s.name, q) && !isAdultContent(s.name, s.category_name || ''))
      .slice(0, LIMIT);
    return { live, vod, series };
  }, [catalog, q]);

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

      {loading ? (
        <div className="state">
          <div className="spinner" />
          {t('common.loading')}
        </div>
      ) : q.length < 2 ? (
        <div className="state">{t('search.typeMore')}</div>
      ) : total === 0 ? (
        <div className="state">{t('search.noResults')}</div>
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
