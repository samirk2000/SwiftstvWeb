import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getSeriesInfo, seriesStreamUrl } from '../lib/xtream.js';
import { getSession } from '../lib/session.js';
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
  const [info, setInfo] = useState(null);
  const [server, setServer] = useState(null);
  const [season, setSeason] = useState(null);

  useEffect(() => {
    const saved = getSession();
    if (!saved) {
      navigate('/login', { replace: true });
      return;
    }
    const srv = { baseUrl: saved.baseUrl, username: saved.username, password: saved.password };
    setServer(srv);
    (async () => {
      const res = await getSeriesInfo(srv, id);
      if (res && res.info) setInfo(res.info);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const seasonsList = info?.seasons || [];
  const eps = season
    ? info?.episodes?.[season] || []
    : Object.values(info?.episodes || {}).flat();
  const activeSeason = season || (seasonsList.length ? String(seasonsList[0].season_number) : null);

  const play = (ep) => {
    const container = info?.container_extension || 'mp4';
    const url = seriesStreamUrl(server, container, ep, activeSeason, id);
    navigate(
      `/player?type=series&id=${id}&url=${encodeURIComponent(url)}&title=${encodeURIComponent(
        ep.title || ''
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
            <img className="detail-poster" src={info.cover_big || info.cover} alt={info.name} />
            <div className="detail-meta">
              <h1>{info.name}</h1>
              {info.genre ? <div className="badges"><span className="badge">{info.genre}</span></div> : null}
              {info.plot && <p>{info.plot}</p>}
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
