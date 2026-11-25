import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getVodInfo, vodStreamUrl } from '../lib/xtream.js';
import { getSession } from '../lib/session.js';
import { isFavorite, toggleFavorite } from '../lib/session.js';
import { formatDuration } from '../lib/time.js';
import { pickSynopsis } from '../lib/metaText.js';
import { hasAdultPin, needsAdultGate, hasAdultBrowseUnlock } from '../lib/parental.js';
import AdultPinDialog from '../components/AdultPinDialog.jsx';
import { useFocusWhenReady } from '../components/Focusable.jsx';
import { Tile, SkeletonRow } from '../components/ui.jsx';
import { getContinueWatching } from '../lib/session.js';
import { loadSimilar } from '../lib/homeRows.js';
import { firstBackdrop, gridPoster } from '../lib/text.js';

function clock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function addedLabel(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1e9) return '';
  const d = new Date(n * 1000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/** "Más como esto": same category, newest first. Lazy, never blocks the page. */
export function SimilarRow({ server, kind, catId, excludeId, onOpen }) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    let alive = true;
    setItems(null);
    if (!server || !catId) return undefined;
    loadSimilar(server, kind, catId, excludeId)
      .then((list) => alive && setItems(list))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [server, kind, catId, excludeId]);
  if (items && !items.length) return null;
  return (
    <section className="row similar-row">
      <h2 className="row-title">{t('vod.moreLikeThis')}</h2>
      {!items ? (
        <SkeletonRow poster count={6} />
      ) : (
        <div className="row-scroll">
          {items.map((it) => (
            <Tile
              key={it.id}
              focusKey={`similar-${kind}-${it.id}`}
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

export default function VodDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);
  const [server, setServer] = useState(null);
  const [fav, setFav] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [adultOk, setAdultOk] = useState(() => hasAdultBrowseUnlock());

  useEffect(() => {
    const saved = getSession();
    if (!saved) {
      navigate('/login', { replace: true });
      return;
    }
    const srv = { baseUrl: saved.baseUrl, username: saved.username, password: saved.password };
    setServer(srv);
    setInfo(null);
    setFav(isFavorite('vod', id));
    setAdultOk(hasAdultBrowseUnlock());
    (async () => {
      // get_vod_info returns { info, movie_data }; keep the WHOLE object so the
      // detail reads both the stream (info.info) and its metadata (movie_data).
      const res = await getVodInfo(srv, id);
      if (res && res.info) setInfo(res);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const streamData = info?.info || {};
  // Panels disagree on where metadata lives — check both bags.
  const meta = info?.movie_data || info?.info || {};
  const title = streamData?.name || meta?.name || '';
  const categoryName = streamData?.category_name || meta?.category_name || '';
  const isAdult = needsAdultGate(title, categoryName);
  const synopsis = pickSynopsis(
    meta.plot,
    meta.description,
    meta.synopsis,
    meta.overview,
    meta.movie_plot,
    streamData.plot,
    streamData.description
  );

  const poster =
    meta?.cover_big ||
    streamData?.cover_big ||
    streamData?.backdrop_path ||
    meta?.cover ||
    meta?.movie_image ||
    '';

  const backdrop = firstBackdrop(meta?.backdrop_path) || firstBackdrop(streamData?.backdrop_path);
  const resume = getContinueWatching().find((c) => c.type === 'vod' && String(c.id) === String(id));
  const resumeAt = resume && resume.position > 30 ? resume.position : 0;
  const pendingStartRef = useRef(0);

  const doPlay = (start = 0) => {
    const ext = meta?.container_extension || streamData?.container_extension || 'mp4';
    const url = vodStreamUrl(server, id, ext);
    const qs = new URLSearchParams({
      type: 'vod',
      id: String(id),
      url,
      title,
    });
    if (start > 0) qs.set('start', String(Math.floor(start)));
    if (poster) qs.set('image', String(poster));
    navigate(`/player?${qs.toString()}`);
  };

  const play = (start = 0) => {
    if (isAdult && !adultOk) {
      pendingStartRef.current = start;
      setPinOpen(true);
      return;
    }
    doPlay(start);
  };

  const durationLabel = meta?.duration
    ? formatDuration(meta.duration)
    : streamData?.duration
      ? formatDuration(streamData.duration)
      : '';

  useFocusWhenReady(Boolean(info), '[data-tv-autofocus="true"]', [id]);

  return (
    <div>
      <AdultPinDialog
        open={pinOpen}
        creating={!hasAdultPin()}
        onDismiss={() => setPinOpen(false)}
        onUnlocked={() => {
          setAdultOk(true);
          setPinOpen(false);
          doPlay(pendingStartRef.current || 0);
        }}
      />
      <div className="page-head">
        <button tabIndex={0} className="back-btn" onClick={() => navigate(-1)}>
          ← {t('common.back')}
        </button>
        <h1>{t('vod.info')}</h1>
      </div>

      {!info ? (
        <div className="state">
          <div className="spinner" />
          {t('common.loading')}
        </div>
      ) : (
        <>
        <div className="detail-backdrop">
          {backdrop ? (
            <div className="detail-backdrop-img">
              <img src={backdrop} alt="" decoding="async" />
            </div>
          ) : null}
        <div className="detail">
          <img className="detail-poster" src={poster} alt={streamData?.name || meta?.name} />
          <div className="detail-meta">
            <h1>{streamData?.name || meta?.name}</h1>
            <div className="badges">
              {meta?.year || streamData?.year || meta?.releasedate ? (
                <span className="badge">{String(meta?.year || streamData?.year || meta?.releasedate).slice(0, 4)}</span>
              ) : null}
              {Number(meta?.rating) > 0 ? <span className="badge badge--rating">★ {meta.rating}</span> : null}
              {durationLabel ? <span className="badge">{durationLabel}</span> : null}
              {meta?.genre ? <span className="badge">{meta.genre}</span> : null}
              {addedLabel(streamData?.added) ? (
                <span className="badge">{t('vod.addedOn', addedLabel(streamData.added))}</span>
              ) : null}
            </div>

            {synopsis ? (
              <section className="synopsis">
                <h2 className="synopsis-title">{t('vod.synopsis')}</h2>
                <p>{synopsis}</p>
              </section>
            ) : null}

            {meta?.director && meta.director !== 'None' ? (
              <p className="meta-line">
                <strong>{t('vod.director')}:</strong> {meta.director}
              </p>
            ) : null}
            {meta?.cast || meta?.actors ? (
              <p className="meta-line">
                <strong>{t('vod.cast')}:</strong> {meta.cast || meta.actors}
              </p>
            ) : null}

            {resumeAt && resume?.duration > 0 ? (
              <div className="detail-progress" aria-hidden="true">
                <div style={{ width: `${Math.min(100, (resumeAt / resume.duration) * 100)}%` }} />
              </div>
            ) : null}

            <div className="detail-actions">
              {resumeAt ? (
                <>
                  <button tabIndex={0} className="btn-primary btn-lg" data-tv-autofocus="true" onClick={() => play(resumeAt)}>
                    ▶ {t('vod.resumeFrom', clock(resumeAt))}
                  </button>
                  <button tabIndex={0} className="btn-secondary btn-lg" onClick={() => play(0)}>
                    ↺ {t('vod.fromStart')}
                  </button>
                </>
              ) : (
                <button tabIndex={0} className="btn-primary btn-lg" data-tv-autofocus="true" onClick={() => play(0)}>
                  ▶ {t('vod.play')}
                </button>
              )}
              <button
                tabIndex={0}
                className="btn-secondary btn-lg btn-mylist"
                data-on={fav ? 'true' : undefined}
                onClick={() => {
                  const added = toggleFavorite({
                    type: 'vod',
                    id,
                    title,
                    image: poster || '',
                    categoryId: streamData?.category_id || meta?.category_id || '',
                    categoryName,
                  });
                  setFav(added);
                }}
              >
                {fav ? `✓ ${t('vod.inMyList')}` : `+ ${t('vod.myList')}`}
              </button>
            </div>
          </div>
        </div>
        </div>
        {!isAdult ? (
          <SimilarRow
            server={server}
            kind="vod"
            catId={streamData?.category_id || meta?.category_id || ''}
            excludeId={id}
            onOpen={(it) => navigate(`/vod/${it.id}`)}
          />
        ) : null}
        </>
      )}
    </div>
  );
}
