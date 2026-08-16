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
      style={{ ...style, objectFit: 'cover' }}
      onError={(e) => {
        if (e.currentTarget.src !== FALLBACK_ART) e.currentTarget.src = FALLBACK_ART;
      }}
    />
  );
}

// A navigation target for cards. Renders an article with onclick + spatial focus.
export function Tile({
  key,
  title,
  poster,
  meta,
  onActivate,
  onFocus,
  style,
  aspect = '16/9',
}) {
  const { ref, tabIndex } = useFocusable(key);
  return (
    <article
      ref={ref}
      tabIndex={tabIndex}
      className="tile"
      style={{ ...style, aspectRatio: aspect }}
      onMouseEnter={() => ref.current && ref.current.focus()}
      onFocus={onFocus}
      onClick={onActivate}
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
