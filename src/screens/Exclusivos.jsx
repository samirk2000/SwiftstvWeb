import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import {
  fetchCatalog,
  parseM3u,
  parseJsonList,
  extractM3u8,
} from '../lib/exclusivos.js';
import { useFocusable } from '../components/Focusable.jsx';

// Resolve a catalog entry (m3u/json/extract may need a body fetch + parse).
async function resolveChannels(entry) {
  if (entry.type === 'm3u') {
    const body = await fetchFirst(entry.urls);
    return body ? parseM3u(body).map((c, i) => ({ ...c, type: 'direct', id: `${entry.name}-${i}` })) : [];
  }
  if (entry.type === 'json') {
    const body = await fetchFirst(entry.urls);
    return body ? parseJsonList(body).map((c, i) => ({ ...c, type: 'direct', id: `${entry.name}-${i}` })) : [];
  }
  if (entry.type === 'extract') {
    for (const u of entry.urls) {
      const body = await fetchText(u);
      const m3u8 = extractM3u8(body);
      if (m3u8) {
        return [{ name: entry.name, url: m3u8, id: entry.name, mirrors: entry.urls, type: 'direct' }];
      }
    }
    return [];
  }
  // hls / direct
  if (entry.url) {
    return [{ name: entry.name, url: entry.url, id: entry.name, mirrors: entry.urls, type: 'direct' }];
  }
  return [];
}

async function fetchFirst(urls) {
  for (const u of urls || []) {
    const body = await fetchText(u);
    if (body) return body;
  }
  return '';
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { headers: { Accept: '*/*' } });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

function ExclTile({ entry, onActivate }) {
  const { ref, tabIndex } = useFocusable(`excl-${entry.id || entry.name}`);
  return (
    <div
      ref={ref}
      tabIndex={tabIndex}
      className="tile"
      style={{ width: 240 }}
      onClick={() => onActivate(entry)}
      onMouseEnter={() => ref.current && ref.current.focus()}
    >
      <div className="tile-art">
        <div className="tile-title">{entry.name}</div>
      </div>
    </div>
  );
}

export default function Exclusivos() {
  const navigate = useNavigate();
  const [resolved, setResolved] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const cat = await fetchCatalog(force);
      const resolvedList = [];
      for (const src of cat.channels || []) {
        const channels = await resolveChannels(src);
        resolvedList.push(...channels);
      }
      setResolved(resolvedList);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const play = (entry) => {
    // The player sets origin headers dynamically via needsOriginHeaders(url),
    // which checks the published proxy_base_url / host / proxy_path + the
    // origin CDN — no hardcoded hosts anywhere.
    navigate(
      `/player?type=exclusivo&id=${encodeURIComponent(entry.id || entry.name)}&url=${encodeURIComponent(
        entry.url
      )}&title=${encodeURIComponent(entry.name)}`
    );
  };

  return (
    <div>
      <div className="page-head">
        <h1>{t('exclusivos.title')}</h1>
        <button className="btn-ghost" onClick={() => load(true)}>
          ↻ {t('exclusivos.refresh')}
        </button>
      </div>

      {loading ? (
        <div className="state">
          <div className="spinner" />
          {t('exclusivos.loading')}
        </div>
      ) : error ? (
        <div className="state">{t('common.error')}</div>
      ) : resolved.length === 0 ? (
        <div className="state">{t('exclusivos.noActive')}</div>
      ) : (
        <div className="menu-grid">
          {resolved.map((entry) => (
            <ExclTile key={entry.id || entry.name} entry={entry} onActivate={play} />
          ))}
        </div>
      )}
    </div>
  );
}
