import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { getContinueWatching } from '../lib/session.js';
import { getWatchedMap } from '../lib/watched.js';
import { firstBackdrop } from '../lib/text.js';
import { SimilarRow } from './VodDetail.jsx';
import { t } from '../lib/i18n.js';
import { getSeriesInfo, seriesStreamUrl } from '../lib/xtream.js';
import { getSession, isFavorite, toggleFavorite } from '../lib/session.js';
import { useFocusable, useFocusWhenReady } from '../components/Focusable.jsx';
import { pickSynopsis } from '../lib/metaText.js';
import { hasAdultPin, needsAdultGate, hasAdultBrowseUnlock } from '../lib/parental.js';
import AdultPinDialog from '../components/AdultPinDialog.jsx';

function EpisodeRow({ index, ep, onPlay, progress, watched }) {
  const { ref, tabIndex } = useFocusable(`episode-${ep.id}`);
  const pct = progress && progress.duration > 0 ? Math.min(100, (progress.position / progress.duration) * 100) : 0;
  const left = progress && progress.duration > 0 ? Math.max(1, Math.round((progress.duration - progress.position) / 60)) : 0;

  return (
    <div
      ref={ref}
      tabIndex={tabIndex}
      className={`episode ${watched ? 'is-watched' : ''}`}
      onClick={() => onPlay(ep, progress && progress.position > 30 ? progress.position : 0)}
      onMouseEnter={() => ref.current && ref.current.focus()}
    >
      <span className="num">{ep.episode_num || index + 1}</span>
      <span className="name">{ep.title || ep.episode_num || ''}</span>
      {watched ? <span className="ep-watched">✓ {t('series.watched')}</span> : null}
      {!watched && pct > 0 ? <span className="badge">{t('series.minutesLeft', left)}</span> : null}
      {Number(ep.info?.duration_secs) > 0 ? (
        <span className="badge">{Math.round(Number(ep.info.duration_secs) / 60)} min</span>
      ) : ep.info?.duration ? (
        <span className="badge">{ep.info.duration}</span>
      ) : null}
      {!watched && pct > 0 ? (
        <div className="ep-progress" aria-hidden="true">
          <div style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export default function SeriesDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const autoplay = new URLSearchParams(location.search).get('autoplay') === '1';
  const autoplayDoneRef = useRef(false);
  const [info, setInfo] = useState(null);
  const [server, setServer] = useState(null);
  const [season, setSeason] = useState(null);
  const [fav, setFav] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [adultOk, setAdultOk] = useState(() => hasAdultBrowseUnlock());
  const [pendingEp, setPendingEp] = useState(null);

  useEffect(() => {
    const saved = getSession();
    if (!saved) {
      navigate('/login', { replace: true });
      return;
    }
    const srv = { baseUrl: saved.baseUrl, username: saved.username, password: saved.password };
    setServer(srv);
    setInfo(null);
    setSeason(null);
    autoplayDoneRef.current = false;
    setFav(isFavorite('series', id));
    setAdultOk(hasAdultBrowseUnlock());
    setPendingEp(null);
    (async () => {
      const res = await getSeriesInfo(srv, id);
      if (res && res.info) setInfo(res);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Seasons from the list, else from the episode map (some panels send seasons: []).
  const seasonsList = useMemo(() => {
    const listed = (info?.seasons || []).filter((s) => info?.episodes?.[String(s.season_number)]?.length);
    if (listed.length) return listed;
    return Object.keys(info?.episodes || {})
      .sort((a, b) => Number(a) - Number(b))
      .map((n) => ({ season_number: n, name: `T${n}` }));
  }, [info]);

  // Resume point: the series' latest "Continuar viendo" episode.
  const resumeEntry = useMemo(
    () => getContinueWatching().find((c) => c.type === 'series' && String(c.seriesId) === String(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, info],
  );
  const progressById = useMemo(() => {
    const m = new Map();
    for (const c of getContinueWatching()) if (c.type === 'series') m.set(String(c.id), c);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, info]);
  const watchedMap = useMemo(() => getWatchedMap(), [id, info]); // eslint-disable-line react-hooks/exhaustive-deps

  const defaultSeason =
    (resumeEntry?.season && info?.episodes?.[String(resumeEntry.season)] ? String(resumeEntry.season) : null) ||
    (seasonsList.length ? String(seasonsList[0].season_number) : null);
  const activeSeason = season || defaultSeason;
  const eps = (activeSeason && info?.episodes?.[activeSeason]) || [];
  const resumeEp = resumeEntry ? eps.find((e) => String(e.id) === String(resumeEntry.id)) : null;
  // Next unwatched episode after the last watched one (Netflix "Continuar").
  const nextUnwatched = (() => {
    if (resumeEp) return null;
    let lastIdx = -1;
    eps.forEach((e, i) => {
      if (watchedMap[`series:${e.id}`]) lastIdx = i;
    });
    return lastIdx >= 0 && lastIdx < eps.length - 1 ? eps[lastIdx + 1] : null;
  })();
  const mainEp = resumeEp || nextUnwatched || eps[0] || null;
  const mainStart = resumeEp && resumeEntry.position > 30 ? resumeEntry.position : 0;

  const meta = info?.info || {};
  const isAdult = needsAdultGate(meta.name || '', meta.category_name || '');
  const synopsis = pickSynopsis(
    meta.plot,
    meta.description,
    meta.synopsis,
    meta.overview,
    meta.series_desc
  );

  const doPlay = (ep, start = 0) => {
    const container = ep?.container_extension || info?.container_extension || 'mp4';
    const url = seriesStreamUrl(server, container, ep, activeSeason, id);
    const epNum = ep?.episode_num ? `E${ep.episode_num}` : '';
    const title =
      ep?.title ||
      [meta?.name, `T${activeSeason}`, epNum].filter(Boolean).join(' · ') ||
      meta?.name ||
      String(ep?.id || '');
    const cover = meta?.cover_big || meta?.cover || '';
    const qs = new URLSearchParams({
      type: 'series',
      id: String(ep?.id || ''),
      seriesId: String(id),
      season: String(activeSeason || ''),
      url,
      title,
    });
    if (cover) qs.set('image', cover);
    if (start > 0) qs.set('start', String(Math.floor(start)));
    navigate(`/player?${qs.toString()}`);
  };

  const play = (ep, start = 0) => {
    if (isAdult && !adultOk) {
      setPendingEp({ ep, start });
      setPinOpen(true);
      return;
    }
    doPlay(ep, start);
  };

  // Home hero "Reproducir" on a series lands here with ?autoplay=1.
  useEffect(() => {
    if (!autoplay || !info || !mainEp || autoplayDoneRef.current) return;
    autoplayDoneRef.current = true;
    navigate(`/series/${id}`, { replace: true });
    play(mainEp, mainStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay, info, mainEp]);

  useFocusWhenReady(Boolean(info), '[data-tv-autofocus="true"]', [id]);

  return (
    <div>
      <AdultPinDialog
        open={pinOpen}
        creating={!hasAdultPin()}
        onDismiss={() => {
          setPinOpen(false);
          setPendingEp(null);
        }}
        onUnlocked={() => {
          setAdultOk(true);
          setPinOpen(false);
          if (pendingEp) doPlay(pendingEp.ep, pendingEp.start);
          setPendingEp(null);
        }}
      />
      <div className="page-head">
        <button tabIndex={0} className="back-btn" onClick={() => navigate(-1)}>
          ← {t('common.back')}
        </button>
        <h1>{t('series.info')}</h1>
      </div>

      {!info ? (
        <div className="state">
          <div className="spinner" />
          {t('common.loading')}
        </div>
      ) : (
        <>
          <div className="detail-backdrop">
            {firstBackdrop(meta.backdrop_path) ? (
              <div className="detail-backdrop-img">
                <img src={firstBackdrop(meta.backdrop_path)} alt="" decoding="async" />
              </div>
            ) : null}
          <div className="detail">
            <img className="detail-poster" src={meta.cover_big || meta.cover} alt={meta.name} />
            <div className="detail-meta">
              <h1>{meta.name}</h1>
              <div className="badges">
                {meta.releaseDate || meta.releasedate || meta.release_date ? (
                  <span className="badge">{String(meta.releaseDate || meta.releasedate || meta.release_date).slice(0, 4)}</span>
                ) : null}
                {Number(meta.rating) > 0 ? <span className="badge badge--rating">★ {meta.rating}</span> : null}
                {meta.genre ? <span className="badge">{meta.genre}</span> : null}
                {seasonsList.length ? (
                  <span className="badge">
                    {seasonsList.length} {seasonsList.length === 1 ? 'temporada' : 'temporadas'}
                  </span>
                ) : null}
              </div>

              {synopsis ? (
                <section className="synopsis">
                  <h2 className="synopsis-title">{t('series.synopsis')}</h2>
                  <p>{synopsis}</p>
                </section>
              ) : null}

              {meta.cast || meta.actors ? (
                <p className="meta-line">
                  <strong>{t('vod.cast')}:</strong> {meta.cast || meta.actors}
                </p>
              ) : null}
              {meta.director && meta.director !== 'None' ? (
                <p className="meta-line">
                  <strong>{t('vod.director')}:</strong> {meta.director}
                </p>
              ) : null}

              <div className="detail-actions">
                {mainEp ? (
                  <button
                    tabIndex={0}
                    className="btn-primary btn-lg"
                    data-tv-autofocus="true"
                    onClick={() => play(mainEp, mainStart)}
                  >
                    ▶{' '}
                    {resumeEp || nextUnwatched
                      ? t('series.continueEp', activeSeason, mainEp.episode_num || 1)
                      : t('series.playEp', activeSeason, mainEp.episode_num || 1)}
                  </button>
                ) : null}
                <button
                  tabIndex={0}
                  className="btn-secondary btn-lg btn-mylist"
                data-on={fav ? 'true' : undefined}
                  onClick={() => {
                    const added = toggleFavorite({
                      type: 'series',
                      id,
                      title: meta.name || '',
                      image: meta.cover_big || meta.cover || '',
                      categoryId: meta.category_id || '',
                      categoryName: meta.category_name || '',
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

          <h2 className="row-title">{t('series.seasons')}</h2>
          <div className="cat-bar">
            {seasonsList.map((s) => (
              <button
                key={s.season_number}
                tabIndex={0}
                className={`cat-chip ${String(activeSeason) === String(s.season_number) ? 'selected' : ''}`}
                onClick={() => setSeason(String(s.season_number))}
              >
                {s.name || `T${s.season_number}`}
              </button>
            ))}
          </div>

          <h2 className="row-title">
            {t('series.episodes')} · T{activeSeason}
          </h2>
          {eps.length ? (
            <div className="episode-list">
              {eps.map((ep, i) => (
                <EpisodeRow
                  key={ep.id}
                  index={i}
                  ep={ep}
                  onPlay={play}
                  progress={progressById.get(String(ep.id))}
                  watched={Boolean(watchedMap[`series:${ep.id}`])}
                />
              ))}
            </div>
          ) : (
            <div className="state">{t('vod.noResults')}</div>
          )}

          {!isAdult ? (
            <SimilarRow
              server={server}
              kind="series"
              catId={meta.category_id || ''}
              excludeId={id}
              onOpen={(it) => navigate(`/series/${it.id}`)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
