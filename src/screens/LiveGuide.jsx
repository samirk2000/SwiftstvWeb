import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getLiveCategories, getLiveStreams, liveStreamUrl } from '../lib/xtream.js';
import { usePanelList } from '../hooks/usePanelList.js';
import { useFocusable } from '../components/Focusable.jsx';

function ChannelRow({ channel, index, onPlay }) {
  const key = `live-ch-${channel.stream_id}`;
  const { ref, tabIndex } = useFocusable(key);

  return (
    <div
      ref={ref}
      tabIndex={tabIndex}
      className="channel"
      onClick={onPlay}
      onMouseEnter={() => ref.current && ref.current.focus()}
    >
      <span className="channel-num">{index + 1}</span>
      <span className="channel-name">{channel.name}</span>
      <span className="channel-meta">
        {channel.epg_channel_id ? ` · ${channel.epg_channel_id}` : ''}
      </span>
    </div>
  );
}

export default function LiveGuide() {
  const navigate = useNavigate();
  const { data: categories, server } = usePanelList(getLiveCategories);
  const [catId, setCatId] = useState('');
  const catArgs = useMemo(() => (catId ? [catId] : []), [catId]);
  const { data: streams, loading, error } = usePanelList(getLiveStreams, catArgs);

  const playChannel = (ch) => {
    const url = liveStreamUrl(server, ch.stream_id);
    navigate(`/player?type=live&id=${ch.stream_id}&url=${encodeURIComponent(url)}`);
  };

  return (
    <div>
      <div className="page-head">
        <h1>{t('live.title')}</h1>
      </div>

      {categories && categories.length > 0 && (
        <div className="cat-bar">
          <button
            className={`cat-chip ${catId === '' ? 'selected' : ''}`}
            onClick={() => setCatId('')}
          >
            {t('live.all')}
          </button>
          {categories.map((cat) => (
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
      ) : error || !streams?.length ? (
        <div className="state">
          {error ? t('common.error') : t('vod.noResults')}
        </div>
      ) : (
        <div className="channel-list">
          {streams.map((ch, i) => (
            <ChannelRow key={ch.stream_id} channel={ch} index={i} onPlay={() => playChannel(ch)} />
          ))}
        </div>
      )}
    </div>
  );
}
