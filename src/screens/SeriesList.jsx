import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getSeriesCategories, getSeries } from '../lib/xtream.js';
import { usePanelList } from '../hooks/usePanelList.js';
import { usePersistedCategory } from '../hooks/usePersistedCategory.js';
import { isCategoryLocked } from '../lib/parental.js';
import { useFocusable } from '../components/Focusable.jsx';

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
        <img src={series.cover || series.poster} alt={series.name} loading="lazy" />
        <div className="tile-title">{series.name}</div>
      </div>
    </div>
  );
}

export default function SeriesList() {
  const navigate = useNavigate();
  const { data: categories } = usePanelList(getSeriesCategories);
  const [catId, setCatId] = usePersistedCategory('series');
  const catArgs = useMemo(() => (catId ? [catId] : []), [catId]);
  const { data: series, loading, error } = usePanelList(getSeries, catArgs);
  const [query, setQuery] = useState('');
  const visibleCats = useMemo(
    () => (categories || []).filter((c) => !isCategoryLocked(c.category_id)),
    [categories]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !series) return series || [];
    return (series || []).filter((s) => String(s.name || '').toLowerCase().includes(q));
  }, [series, query]);

  return (
    <div>
      <div className="page-head">
        <h1>{t('series.title')}</h1>
      </div>

      <input
        className="search-box"
        placeholder={t('series.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {visibleCats && visibleCats.length > 0 && (
        <div className="cat-bar">
          <button className={`cat-chip ${catId === '' ? 'selected' : ''}`} onClick={() => setCatId('')}>
            {t('live.all')}
          </button>
          {visibleCats.map((cat) => (
            <button
              key={cat.category_id}
              className={`cat-chip ${String(catId) === String(cat.category_id) ? 'selected' : ''}`}
              onClick={() => setCatId(String(cat.category_id))}
            >
              {cat.category_name}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="state">
          <div className="spinner" />
          {t('common.loading')}
        </div>
      ) : error || !filtered?.length ? (
        <div className="state">{t('vod.noResults')}</div>
      ) : (
        <div className="grid">
          {filtered.map((s) => (
            <SeriesTile
              key={s.series_id}
              series={s}
              onOpen={() => navigate(`/series/${s.series_id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
