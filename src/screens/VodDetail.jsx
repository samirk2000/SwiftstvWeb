import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getVodInfo, vodStreamUrl } from '../lib/xtream.js';
import { getSession } from '../lib/session.js';
import { isFavorite, toggleFavorite } from '../lib/session.js';
import { formatDuration } from '../lib/time.js';
import { pickSynopsis } from '../lib/metaText.js';

export default function VodDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);
  const [server, setServer] = useState(null);
  const [fav, setFav] = useState(false);

  useEffect(() => {
    const saved = getSession();
    if (!saved) {
      navigate('/login', { replace: true });
      return;
    }
    const srv = { baseUrl: saved.baseUrl, username: saved.username, password: saved.password };
    setServer(srv);
    setFav(isFavorite('vod', id));
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
  const synopsis = pickSynopsis(
    meta.plot,
    meta.description,
    meta.synopsis,
    meta.overview,
    meta.movie_plot,
    streamData.plot,
    streamData.description
  );

  const play = () => {
    const ext = meta?.container_extension || streamData?.container_extension || 'mp4';
    const url = vodStreamUrl(server, id, ext);
    navigate(
      `/player?type=vod&id=${id}&url=${encodeURIComponent(url)}&title=${encodeURIComponent(
        streamData?.name || meta?.name || ''
      )}`
    );
  };

  const poster =
    meta?.cover_big ||
    streamData?.cover_big ||
    streamData?.backdrop_path ||
    meta?.cover ||
    meta?.movie_image;

  const durationLabel = meta?.duration
    ? formatDuration(meta.duration)
    : streamData?.duration
      ? formatDuration(streamData.duration)
      : '';

  return (
    <div>
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
        <div className="detail">
          <img className="detail-poster" src={poster} alt={streamData?.name || meta?.name} />
          <div className="detail-meta">
            <h1>{streamData?.name || meta?.name}</h1>
            <div className="badges">
              {meta?.year ? <span className="badge">{meta.year}</span> : null}
              {meta?.rating ? <span className="badge">★ {meta.rating}</span> : null}
              {durationLabel ? <span className="badge">{durationLabel}</span> : null}
              {meta?.genre ? <span className="badge">{meta.genre}</span> : null}
              {streamData?.added ? <span className="badge">{streamData.added}</span> : null}
            </div>

            {synopsis ? (
              <section className="synopsis">
                <h2 className="synopsis-title">{t('vod.synopsis')}</h2>
                <p>{synopsis}</p>
              </section>
            ) : null}

            {meta?.director ? (
              <p className="meta-line">
                <strong>{t('vod.director')}:</strong> {meta.director}
              </p>
            ) : null}
            {meta?.cast || meta?.actors ? (
              <p className="meta-line">
                <strong>{t('vod.cast')}:</strong> {meta.cast || meta.actors}
              </p>
            ) : null}

            <div className="detail-actions">
              <button tabIndex={0} className="btn-primary" onClick={play}>
                ▶ {t('vod.play')}
              </button>
              <button
                tabIndex={0}
                className={fav ? 'btn-ghost fav-on' : 'btn-ghost'}
                onClick={() => {
                  const added = toggleFavorite({
                    type: 'vod',
                    id,
                    title: streamData?.name || meta?.name || '',
                    image: poster || '',
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
      )}
    </div>
  );
}
