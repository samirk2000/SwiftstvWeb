import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getVodCategories, getVodStreams } from '../lib/xtream.js';
import { usePanelList } from '../hooks/usePanelList.js';
import { usePersistedCategory } from '../hooks/usePersistedCategory.js';
import { usePreferFirstCategory } from '../hooks/usePreferFirstCategory.js';
import { useWindowedList } from '../hooks/useWindowedList.js';
import { isCategoryLocked } from '../lib/parental.js';
import { useFocusable } from '../components/Focusable.jsx';
import { matchesSearch } from '../lib/searchText.js';

const PAGE = 48;

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
        <img
          src={vod.stream_icon || vod.cover}
          alt=""
          loading="lazy"
          decoding="async"
        />
        <div className="tile-title">{vod.name}</div>
      </div>
    </div>
  );
}

export default function VodGrid() {
  const navigate = useNavigate();
  const { data: categories } = usePanelList(getVodCategories);
  const [catId, setCatId] = usePersistedCategory('vod');
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

  const { data: streams, loading, error } = usePanelList(getVodStreams, catArgs, {
    enabled: ready,
  });

  const filtered = useMemo(() => {
    if (!streams) return [];
    if (!query.trim()) return streams;
    return streams.filter((v) => matchesSearch(v.name, query));
  }, [streams, query]);

  const { visible, hasMore, loadMore, remaining } = useWindowedList(filtered, PAGE);

  const onQueryChange = (e) => {
    const v = e.target.value;
    setQuery(v);
    if (v.trim() && catId) setCatId('');
  };

  return (
    <div>
      <div className="page-head">
        <h1>{t('vod.title')}</h1>
      </div>

      <input
        tabIndex={0}
        className="search-box"
        placeholder={t('vod.search')}
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
            {visible.map((vod) => (
              <VodTile
                key={vod.stream_id}
                vod={vod}
                onOpen={() => navigate(`/vod/${vod.stream_id}`)}
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
