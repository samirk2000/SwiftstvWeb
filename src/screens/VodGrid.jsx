import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getVodCategories, getVodStreams } from '../lib/xtream.js';
import { usePanelList } from '../hooks/usePanelList.js';
import { usePersistedCategory } from '../hooks/usePersistedCategory.js';
import { isCategoryLocked } from '../lib/parental.js';
import { useFocusable } from '../components/Focusable.jsx';

function VodTile({ vod, onOpen }) {
  const { ref, tabIndex } = useFocusable(`vod-${vod.stream_id}`);
  return (
    <div
      ref={ref}
      tabIndex={tabIndex}
      className="tile poster"
      onClick={() => onOpen(vod)}
      onMouseEnter={() => ref.current && ref.current.focus()}
    >
      <div className="tile-art">
        <img src={vod.stream_icon || vod.cover} alt={vod.name} loading="lazy" />
        <div className="tile-title">{vod.name}</div>
      </div>
    </div>
  );
}

export default function VodGrid() {
  const navigate = useNavigate();
  const { data: categories } = usePanelList(getVodCategories);
  const [catId, setCatId] = usePersistedCategory('vod');
  const catArgs = useMemo(() => (catId ? [catId] : []), [catId]);
  const { data: streams, loading, error } = usePanelList(getVodStreams, catArgs);
  const [query, setQuery] = useState('');
  const visibleCats = useMemo(
    () => (categories || []).filter((c) => !isCategoryLocked(c.category_id)),
    [categories]
  );

  // Client-side search over the current category's stream list.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !streams) return streams || [];
    return (streams || []).filter((v) => String(v.name || '').toLowerCase().includes(q));
  }, [streams, query]);

  return (
    <div>
      <div className="page-head">
        <h1>{t('vod.title')}</h1>
      </div>

      <input
        className="search-box"
        placeholder={t('vod.search')}
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
          {filtered.map((vod) => (
            <VodTile
              key={vod.stream_id}
              vod={vod}
              onOpen={() => navigate(`/vod/${vod.stream_id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
