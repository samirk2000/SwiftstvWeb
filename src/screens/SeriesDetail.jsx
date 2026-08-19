import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getSeriesInfo, seriesStreamUrl } from '../lib/xtream.js';
import { getSession, isFavorite, toggleFavorite } from '../lib/session.js';
import { useFocusable } from '../components/Focusable.jsx';

function EpisodeRow({ index, ep, onPlay }) {
  const { ref, tabIndex } = useFocusable(`episode-${ep.id}`);
  return (
    <div
      ref={ref}
      tabIndex={tabIndex}
      className="episode"
      onClick={() => onPlay(ep)}
      onMouseEnter={() => ref.current && ref.current.focus()}
    >
      <span className="num">{index + 1}</span>
      <span className="name">{ep.title || ep.episode_num || ''}</span>
      {ep.info?.duration ? <span className="badge">{ep.info.duration}′</span> : null}
    </div>
  );
}

export default function SeriesDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState(null); // { info, seasons, episodes }
  const [server, setServer] = useState(null);
  const [season, setSeason] = useState(null);
  const [fav, setFav] = useState(false);

  useEffect(() => {
    const saved = getSession();
    if (!saved) {
      navigate('/login', { replace: true });
      return;
    }
    const srv = { baseUrl: saved.baseUrl, username: saved.username, password: saved.password };
    setServer(srv);
    setFav(isFavorite('series', id));
    (async () => {
      // get_series_info returns { info, seasons, episodes } where seasons and
      // episodes are TOP-LEVEL siblings of info. Keep the whole object (not just
      // .info) so the seasons/episodes below resolve.
      const res = await getSeriesInfo(srv, id);
      if (res && res.info) setInfo(res);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const seasonsList = info?.seasons || [];
  const eps = season
    ? info?.episodes?.[season] || []
    : Object.values(info?.episodes || {}).flat();
  const activeSeason = season || (seasonsList.length ? String(seasonsList[0].season_number) : null);

  const meta = info?.info || {};

  const play = (ep) => {
    // The container extension lives on each episode (e.g. "mp4"); fall back to
    // the series-level one if present, else 'mp4'.
    const container = ep?.container_extension || info?.container_extension || 'mp4';
    const url = seriesStreamUrl(server, container, ep, activeSeason, id);
    // Continue-watching is keyed by (type, id): pass the EPISODE id (not the
    // series id) so each episode keeps its own resume position, and pass a
    // meaningful title (episode title, else "Series · T# · E#").
    const epNum = ep?.episode_num ? `E${ep.episode_num}` : '';
    const title =
      ep?.title ||
      [meta?.name, `T${activeSeason}`, epNum].filter(Boolean).join(' · ') ||
      meta?.name ||
      String(ep?.id || '');
    navigate(
      `/player?type=series&id=${ep?.id}&url=${encodeURIComponent(url)}&title=${encodeURIComponent(
        title
      )}`
    );
  };

  return (
    <div>
      <div className="page-head">
        <button className="back-btn" onClick={() => navigate(-1)}>
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
          <div className="detail">
            <img className="detail-poster" src={meta.cover_big || meta.cover} alt={meta.name} />
            <div className="detail-meta">
              <h1>{meta.name}</h1>
              {meta.genre ? <div className="badges"><span className="badge">{meta.genre}</span></div> : null}
              {meta.plot && <p>{meta.plot}</p>}
              <div className="detail-actions">
                <button
                  className={fav ? 'btn-ghost fav-on' : 'btn-ghost'}
                  onClick={() => {
                    const added = toggleFavorite({
                      type: 'series',
                      id,
                      title: meta.name || '',
                      image: meta.cover_big || meta.cover || '',
                    });
                    setFav(added);
                  }}
                >
                  {fav ? '★ ' : '☆ '}
                  {t('common.favorite')}
                </button>
              </div>
            </div>
          </div>

          <h2 className="row-title">{t('series.seasons')}</h2>
          <div className="cat-bar">
            {seasonsList.map((s) => (
              <button
                key={s.season_number}
                className={`cat-chip ${String(activeSeason) === String(s.season_number) ? 'selected' : ''}`}
                onClick={() => setSeason(String(s.season_number))}
              >
                {s.name || `T${s.season_number}`}
              </button>
            ))}
          </div>

          <h2 className="row-title">{t('series.episodes')} · T{activeSeason}</h2>
          {eps.length ? (
            <div className="episode-list">
              {eps.map((ep, i) => (
                <EpisodeRow key={ep.id} index={i} ep={ep} onPlay={play} />
              ))}
            </div>
          ) : (
            <div className="state">{t('vod.noResults')}</div>
          )}
        </>
      )}
    </div>
  );
}
