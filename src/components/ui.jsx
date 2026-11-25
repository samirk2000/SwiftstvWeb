// Reusable TV-first UI primitives: posters, rows of cards, section titles.
import { Fragment } from 'react';
import { useFocusable } from './Focusable.jsx';

const FALLBACK_ART = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="%23222a35"/><text x="100" y="155" font-size="60" fill="%234f5b6b" text-anchor="middle">?</text></svg>';

export function Poster({ src, title, style }) {
  return (
    <img
      src={src || FALLBACK_ART}
      alt={title || ''}
      loading="lazy"
      decoding="async"
      style={{ ...style, objectFit: 'cover' }}
      onError={(e) => {
        if (e.currentTarget.src !== FALLBACK_ART) e.currentTarget.src = FALLBACK_ART;
      }}
    />
  );
}

// A navigation target for cards. Renders an article with onclick + spatial focus.
// NOTE: never name a prop `key` — React strips it. Use `focusKey` instead.
export function Tile({
  focusKey,
  title,
  poster,
  meta,
  onActivate,
  onFocus,
  style,
  aspect = '16/9',
  className = '',
  progress,
  badge,
}) {
  const { ref, tabIndex } = useFocusable(focusKey || title || 'tile');
  const pct = Number.isFinite(progress) ? Math.max(2, Math.min(100, progress * 100)) : null;
  return (
    <article
      ref={ref}
      tabIndex={tabIndex}
      className={`tile ${className}`.trim()}
      style={{ ...style, aspectRatio: aspect }}
      onMouseEnter={() => ref.current && ref.current.focus()}
      onFocus={onFocus}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onActivate) {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      <div className="tile-art">
        <Poster src={poster} title={title} />
        {meta ? (
          <div className="tile-meta">
            <span>{title}</span>
            <span className="tile-meta-sub">{meta}</span>
          </div>
        ) : (
          <div className="tile-title">{title}</div>
        )}
        {badge ? <span className="tile-badge">{badge}</span> : null}
        {pct !== null ? (
          <div className="tile-progress" aria-hidden="true">
            <div className="tile-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

// Horizontal scrolling row of tiles.
export function Row({ title, items, itemKey, renderItem, empty }) {
  return (
    <section className="row">
      {title ? <h2 className="row-title">{title}</h2> : null}
      {items && items.length ? (
        <div className="row-scroll">
          {items.map((item, i) => (
            <Fragment key={typeof itemKey === 'function' ? itemKey(item) : itemKey(item, i)}>
              {renderItem(item, i)}
            </Fragment>
          ))}
        </div>
      ) : (
        <p className="row-empty">{empty || 'Nothing here yet.'}</p>
      )}
    </section>
  );
}

// Grey placeholder tiles while a row loads (cheap opacity pulse, no layout work).
export function SkeletonRow({ count = 7, poster = true }) {
  return (
    <div className="row-scroll row-scroll--skeleton" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`skeleton-tile ${poster ? 'skeleton-tile--poster' : ''}`} />
      ))}
    </div>
  );
}
