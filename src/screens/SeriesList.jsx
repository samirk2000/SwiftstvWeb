import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getSeriesCategories, getSeries } from '../lib/xtream.js';
import { usePanelList } from '../hooks/usePanelList.js';
import { usePersistedCategory } from '../hooks/usePersistedCategory.js';
import { usePreferFirstCategory } from '../hooks/usePreferFirstCategory.js';
import { useWindowedList } from '../hooks/useWindowedList.js';
import { isCategoryLocked, hasAdultPin, needsAdultGate, unlockAdultBrowse, clearAdultBrowseUnlock, isAdultBrowseUnlocked } from '../lib/parental.js';
import { isAdultCategory, isAdultContent } from '../lib/adult.js';
import { getFavoritesByType } from '../lib/session.js';
import { useFocusable } from '../components/Focusable.jsx';
import AdultPinDialog from '../components/AdultPinDialog.jsx';
import { matchesSearch } from '../lib/searchText.js';

const PAGE = 48;
const CAT_FAVORITES = '__favorites__';

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
  const [pinPending, setPinPending] = useState(null);
  const searchActive = Boolean(query.trim());
  const localFav = catId === CAT_FAVORITES;
  const ready = searchActive || catId !== null;
  const effectiveCatId = searchActive || localFav ? '' : catId || '';
  const catArgs = useMemo(
    () => (effectiveCatId ? [effectiveCatId] : []),
    [effectiveCatId]
  );

  const catNameById = useMemo(() => {
    const m = new Map();
    for (const c of categories || []) m.set(String(c.category_id), c.category_name);
    return m;
  }, [categories]);

  const visibleCats = useMemo(
    () => (categories || []).filter((c) => !isCategoryLocked(c.category_id)),
    [categories]
  );
  const preferCats = useMemo(
    () => (visibleCats || []).filter((c) => !isAdultCategory(c.category_name)),
    [visibleCats]
  );
  usePreferFirstCategory(
    catId,
    setCatId,
    preferCats.length ? preferCats : visibleCats,
    searchActive
  );

  const { data: series, loading, error } = usePanelList(getSeries, catArgs, {
    enabled: ready && !localFav,
  });

  const favSeries = useMemo(
    () =>
      getFavoritesByType('series')
        .filter((f) => !isAdultContent(f.title, f.categoryName))
        .map((f) => ({
          series_id: f.id,
          name: f.title,
          cover: f.image,
          poster: f.image,
          category_id: f.categoryId || CAT_FAVORITES,
          category_name: f.categoryName || '',
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catId],
  );

  const filtered = useMemo(() => {
    const base = localFav ? favSeries : series || [];
    if (!query.trim()) return base;
    return base.filter((s) => matchesSearch(s.name, query));
  }, [series, favSeries, localFav, query]);

  const { visible, hasMore, loadMore, remaining } = useWindowedList(filtered, PAGE);

  const onQueryChange = (e) => {
    const v = e.target.value;
    setQuery(v);
    if (v.trim() && catId) setCatId('');
  };

  const applyCat = (id) => {
    setQuery('');
    setCatId(id);
  };

  const selectCat = (id) => {
    const cat = (visibleCats || []).find((c) => String(c.category_id) === String(id));
    if (cat && isAdultCategory(cat.category_name)) {
      if (isAdultBrowseUnlocked(id)) {
        applyCat(id);
        return;
      }
      setPinPending({ kind: 'cat', id: String(id) });
      return;
    }
    clearAdultBrowseUnlock();
    applyCat(id);
  };

  const openSeries = (s) => {
    const catName = catNameById.get(String(s.category_id)) || s.category_name || '';
    if (
      needsAdultGate(s.name, catName) &&
      !isAdultBrowseUnlocked(s.category_id) &&
      !isAdultBrowseUnlocked(catId)
    ) {
      setPinPending({
        kind: 'open',
        path: `/series/${s.series_id}`,
        categoryId: s.category_id,
      });
      return;
    }
    navigate(`/series/${s.series_id}`);
  };

  const onPinUnlocked = () => {
    const pending = pinPending;
    setPinPending(null);
    if (!pending) return;
    if (pending.kind === 'cat') {
      unlockAdultBrowse(pending.id);
      applyCat(pending.id);
      return;
    }
    if (pending.kind === 'open' && pending.path) {
      if (pending.categoryId) unlockAdultBrowse(pending.categoryId);
      else if (catId) unlockAdultBrowse(catId);
      navigate(pending.path);
    }
  };

  return (
    <div>
      <AdultPinDialog
        open={Boolean(pinPending)}
        creating={!hasAdultPin()}
        onDismiss={() => setPinPending(null)}
        onUnlocked={onPinUnlocked}
      />
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

      <div className="cat-bar">
        <button
          tabIndex={0}
          className={`cat-chip ${!searchActive && catId === CAT_FAVORITES ? 'selected' : ''}`}
          onClick={() => selectCat(CAT_FAVORITES)}
        >
          {t('series.favorites')}
        </button>
        <button
          tabIndex={0}
          className={`cat-chip ${!searchActive && catId === '' ? 'selected' : ''}`}
          onClick={() => selectCat('')}
        >
          {t('live.all')}
        </button>
        {(visibleCats || []).map((cat) => (
          <button
            key={cat.category_id}
            tabIndex={0}
            className={`cat-chip ${
              !searchActive && String(catId) === String(cat.category_id) ? 'selected' : ''
            }`}
            onClick={() => selectCat(String(cat.category_id))}
          >
            {cat.category_name}
          </button>
        ))}
      </div>

      {ready && !localFav && loading ? (
        <div className="state">
          <div className="spinner" />
          {t('common.loading')}
        </div>
      ) : error || !filtered?.length ? (
        <div className="state">
          {error
            ? t('common.error')
            : localFav
              ? t('series.noFavorites')
              : t('vod.noResults')}
        </div>
      ) : (
        <>
          <div className="grid">
            {visible.map((s) => (
              <SeriesTile key={s.series_id} series={s} onOpen={openSeries} />
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
