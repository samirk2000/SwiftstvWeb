import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getVodInfo, vodStreamUrl } from '../lib/xtream.js';
import { getSession } from '../lib/session.js';
import { formatDuration } from '../lib/time.js';

export default function VodDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);
  const [server, setServer] = useState(null);

  useEffect(() => {
    const saved = getSession();
    if (!saved) {
      navigate('/login', { replace: true });
      return;
    }
    const srv = { baseUrl: saved.baseUrl, username: saved.username, password: saved.password };
    setServer(srv);
    (async () => {
      // get_vod_info returns { info, movie_data }; keep the WHOLE object so the
      // detail reads both the stream (info.info) and its metadata (movie_data).
      const res = await getVodInfo(srv, id);
      if (res && res.info) setInfo(res);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const streamData = info?.info || {}; // the VOD stream (name, cover_big)
  const meta = info?.movie_data || {}; // movie metadata (plot, year, ext)
  const play = () => {
    const ext = (meta?.container_extension) || 'mp4';
    const url = vodStreamUrl(server, id, ext);
    navigate(`/player?type=vod&id=${id}&url=${encodeURIComponent(url)}&title=${encodeURIComponent(streamData?.name || '')}`);
  };

  const poster =
    meta?.cover_big || streamData?.cover_big || streamData?.backdrop_path || meta?.cover;

  return (
    <div>
      <div className="page-head">
        <button className="back-btn" onClick={() => navigate(-1)}>
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
          <img className="detail-poster" src={poster} alt={streamData?.name} />
          <div className="detail-meta">
            <h1>{streamData?.name}</h1>
            <div className="badges">
              {meta?.year ? <span className="badge">{meta.year}</span> : null}
              {meta?.rating ? <span className="badge">★ {meta.rating}</span> : null}
              {meta?.duration ? <span className="badge">{formatDuration(meta.duration)}</span> : null}
              {streamData?.added ? <span className="badge">{streamData.added}</span> : null}
            </div>
            <p>{meta?.plot || meta?.description || ''}</p>
            {meta?.genre ? <p className="badge">{meta.genre}</p> : null}
            <div className="detail-actions">
              <button className="btn-primary" onClick={play}>
                ▶ {t('vod.play')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
