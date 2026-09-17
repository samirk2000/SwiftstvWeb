import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getVodCategories, getVodStreams } from '../lib/xtream.js';
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

  const { data: streams, loading, error } = usePanelList(getVodStreams, catArgs, {
    enabled: ready && !localFav,
  });

  const favStreams = useMemo(
    () =>
      getFavoritesByType('vod')
        .filter((f) => !isAdultContent(f.title, f.categoryName))
        .map((f) => ({
          stream_id: f.id,
          name: f.title,
          stream_icon: f.image,
          cover: f.image,
          category_id: f.categoryId || CAT_FAVORITES,
          category_name: f.categoryName || '',
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catId],
  );

  const filtered = useMemo(() => {
    const base = localFav ? favStreams : streams || [];
    if (!query.trim()) return base;
    return base.filter((v) => matchesSearch(v.name, query));
  }, [streams, favStreams, localFav, query]);

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

  const openVod = (vod) => {
    const catName =
      catNameById.get(String(vod.category_id)) || vod.category_name || '';
    if (
      needsAdultGate(vod.name, catName) &&
      !isAdultBrowseUnlocked(vod.category_id) &&
      !isAdultBrowseUnlocked(catId)
    ) {
      setPinPending({ kind: 'open', path: `/vod/${vod.stream_id}`, categoryId: vod.category_id });
      return;
    }
    navigate(`/vod/${vod.stream_id}`);
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
        <h1>{t('vod.title')}</h1>
      </div>

      <input
        tabIndex={0}
        className="search-box"
        placeholder={t('vod.search')}
        value={query}
        onChange={onQueryChange}
      />

      <div className="cat-bar">
        <button
          tabIndex={0}
          className={`cat-chip ${!searchActive && catId === CAT_FAVORITES ? 'selected' : ''}`}
          onClick={() => selectCat(CAT_FAVORITES)}
        >
          {t('vod.favorites')}
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
          {error ? t('common.error') : localFav ? t('vod.noFavorites') : t('vod.noResults')}
        </div>
      ) : (
        <>
          <div className="grid">
            {visible.map((vod) => (
              <VodTile key={vod.stream_id} vod={vod} onOpen={openVod} />
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
