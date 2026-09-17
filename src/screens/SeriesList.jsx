import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getSeriesCategories, getSeries } from '../lib/xtream.js';
import { usePanelList } from '../hooks/usePanelList.js';
import { usePersistedCategory } from '../hooks/usePersistedCategory.js';
import { usePreferFirstCategory } from '../hooks/usePreferFirstCategory.js';
import { useWindowedList } from '../hooks/useWindowedList.js';
import { isCategoryLocked } from '../lib/parental.js';
import { useFocusable } from '../components/Focusable.jsx';
import { matchesSearch } from '../lib/searchText.js';

const PAGE = 48;

function SeriesTile({ series, onOpen }) {
  const { ref, tabIndex } = useFocusable(`series-${series.series_id}`);
  return (
    <div
      ref={ref}
      tabIndex={tabIndex}
      className="tile poster"
      onClick={() => onOpen(series)}
      onMouseEnter={() => ref.current && ref.current.focus()}
    >
      <div className="tile-art">
        <img
          src={series.cover || series.poster}
          alt=""
          loading="lazy"
          decoding="async"
        />
        <div className="tile-title">{series.name}</div>
      </div>
    </div>
  );
}

export default function SeriesList() {
  const navigate = useNavigate();
  const { data: categories } = usePanelList(getSeriesCategories);
  const [catId, setCatId] = usePersistedCategory('series');
  const [query, setQuery] = useState('');
  const searchActive = Boolean(query.trim());
  const ready = searchActive || catId !== null;
  const effectiveCatId = searchActive ? '' : catId || '';
  const catArgs = useMemo(
    () => (effectiveCatId ? [effectiveCatId] : []),
    [effectiveCatId]
  );

  const visibleCats = useMemo(
    () => (categories || []).filter((c) => !isCategoryLocked(c.category_id)),
    [categories]
  );
  usePreferFirstCategory(catId, setCatId, visibleCats, searchActive);

  const { data: series, loading, error } = usePanelList(getSeries, catArgs, {
    enabled: ready,
  });

  const filtered = useMemo(() => {
    if (!series) return [];
    if (!query.trim()) return series;
    return series.filter((s) => matchesSearch(s.name, query));
  }, [series, query]);

  const { visible, hasMore, loadMore, remaining } = useWindowedList(filtered, PAGE);

  const onQueryChange = (e) => {
    const v = e.target.value;
    setQuery(v);
    if (v.trim() && catId) setCatId('');
  };

  return (
    <div>
      <div className="page-head">
        <h1>{t('series.title')}</h1>
      </div>

      <input
        tabIndex={0}
        className="search-box"
        placeholder={t('series.search')}
        value={query}
        onChange={onQueryChange}
      />

      {visibleCats && visibleCats.length > 0 && (
        <div className="cat-bar">
          <button
            tabIndex={0}
            className={`cat-chip ${!searchActive && catId === '' ? 'selected' : ''}`}
            onClick={() => {
              setQuery('');
              setCatId('');
            }}
          >
            {t('live.all')}
          </button>
          {visibleCats.map((cat) => (
            <button
              key={cat.category_id}
              tabIndex={0}
              className={`cat-chip ${
                !searchActive && String(catId) === String(cat.category_id) ? 'selected' : ''
              }`}
              onClick={() => {
                setQuery('');
                setCatId(String(cat.category_id));
              }}
            >
              {cat.category_name}
            </button>
          ))}
        </div>
      )}

      {!ready || loading ? (
        <div className="state">
          <div className="spinner" />
          {t('common.loading')}
        </div>
      ) : error || !filtered?.length ? (
        <div className="state">{t('vod.noResults')}</div>
      ) : (
        <>
          <div className="grid">
            {visible.map((s) => (
              <SeriesTile
                key={s.series_id}
                series={s}
                onOpen={() => navigate(`/series/${s.series_id}`)}
              />
            ))}
          </div>
          {hasMore ? (
            <div className="load-more-wrap">
              <button tabIndex={0} className="btn-primary load-more-btn" onClick={loadMore}>
                {t('common.loadMore', remaining)}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
