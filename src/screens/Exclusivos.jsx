import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { fetchCatalog, parseM3u, parseJsonList, extractM3u8 } from '../lib/exclusivos.js';
import { corsFetch } from '../lib/cors.js';
import { useFocusable, setFocused } from '../components/Focusable.jsx';

// Resolve a catalog entry (m3u/json/extract may need a body fetch + parse).
async function resolveChannels(entry) {
  if (!entry) return [];
  if (entry.type === 'm3u') {
    const body = await fetchFirst(entry.urls);
    return body
      ? parseM3u(body).map((c, i) => ({
          ...c,
          type: 'direct',
          id: `${entry.id || entry.name}-${i}`,
          category: entry.category || '',
        }))
      : [];
  }
  if (entry.type === 'json') {
    const body = await fetchFirst(entry.urls);
    return body
      ? parseJsonList(body).map((c, i) => ({
          ...c,
          type: 'direct',
          id: `${entry.id || entry.name}-${i}`,
          category: entry.category || '',
        }))
      : [];
  }
  if (entry.type === 'extract') {
    for (const u of entry.urls || []) {
      const body = await fetchText(u);
      const m3u8 = extractM3u8(body);
      if (m3u8) {
        return [
          {
            name: entry.name,
            url: m3u8,
            id: entry.id || entry.name,
            mirrors: entry.urls,
            type: 'direct',
            category: entry.category || '',
          },
        ];
      }
    }
    return [];
  }
  // hls / direct — remote JSON usually has `urls[]`, not a lone `url`.
  const url = entry.url || (Array.isArray(entry.urls) && entry.urls[0]) || '';
  if (url) {
    return [
      {
        name: entry.name,
        url,
        id: entry.id || entry.name,
        mirrors: entry.urls || (entry.url ? [entry.url] : []),
        type: 'direct',
        category: entry.category || '',
      },
    ];
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
  const res = await corsFetch(url, { userAgent: 'SwiftstvExclusive/1.0' });
  if (!res.ok) return '';
  return res.text;
}

function ExclTile({ entry, onActivate, showCategory = false }) {
  const { ref, tabIndex } = useFocusable(`excl-${entry.id || entry.name}`);
  return (
    <button
      ref={ref}
      type="button"
      tabIndex={tabIndex}
      className="excl-tile"
      onClick={() => onActivate(entry)}
      onMouseEnter={() => ref.current && setFocused(ref.current, { native: false })}
    >
      <span className="excl-tile-icon">⚡</span>
      <span className="excl-tile-name">{entry.name}</span>
      {showCategory && entry.category ? <span className="excl-tile-cat">{entry.category}</span> : null}
    </button>
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
      const sources = cat.channels || [];
      const resolvedList = [];
      for (const src of sources) {
        if (src.needsFetch) {
          const channels = await resolveChannels(src);
          resolvedList.push(...channels);
        } else if (src.url) {
          resolvedList.push({
            name: src.name,
            url: src.url,
            id: src.sourceId || src.name,
            category: src.category || '',
            mirrors: src.mirrors || [],
            type: 'direct',
          });
        } else {
          const channels = await resolveChannels(src);
          resolvedList.push(...channels);
        }
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

  // Land focus on the first channel card — not "Atrás" / "Actualizar".
  useEffect(() => {
    if (loading || !resolved.length) return undefined;
    const timers = [100, 280, 550].map((ms) =>
      window.setTimeout(() => {
        const first = document.querySelector('.excl-tile');
        if (first) setFocused(first, { native: false });
      }, ms),
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [loading, resolved.length]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const ch of resolved) {
      const key = ch.category || t('exclusivos.module');
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ch);
    }
    return [...map.entries()];
  }, [resolved]);

  const play = (entry) => {
    navigate(
      `/player?type=exclusivo&id=${encodeURIComponent(entry.id || entry.name)}&url=${encodeURIComponent(
        entry.url
      )}&title=${encodeURIComponent(entry.name)}`
    );
  };

  return (
    <div className="exclusivos-page">
      <div className="page-head">
        <button tabIndex={0} className="back-btn" onClick={() => navigate(-1)}>
          ← {t('common.back')}
        </button>
        <h1>{t('exclusivos.title')}</h1>
        <button tabIndex={0} className="btn-ghost" onClick={() => load(true)}>
          ↻ {t('exclusivos.refresh')}
        </button>
      </div>

      {loading ? (
        <div className="state">
          <div className="spinner" />
          {t('exclusivos.loading')}
        </div>
      ) : error ? (
        <div className="state">
          {t('common.error')}
          <button tabIndex={0} className="btn-primary" style={{ marginTop: 16 }} onClick={() => load(true)}>
            {t('common.retry')}
          </button>
        </div>
      ) : resolved.length === 0 ? (
        <div className="state">{t('exclusivos.noActive')}</div>
      ) : (
        <div className="exclusivos-body">
          {grouped.map(([cat, items]) => (
            <section key={cat} className="exclusivos-section">
              <h2 className="row-title">{cat}</h2>
              <div className="exclusivos-grid">
                {items.map((entry) => (
                  <ExclTile key={entry.id || entry.name} entry={entry} onActivate={play} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
