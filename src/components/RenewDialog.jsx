import { useMemo } from 'react';
import { t } from '../lib/i18n.js';
import { qrMatrix, qrPath } from '../lib/qr.js';
import { renewUrl } from '../lib/renew.js';
import { FocusScope } from './Focusable.jsx';

function QrCode({ text, size = 220 }) {
  const svg = useMemo(() => {
    const m = qrMatrix(text);
    if (!m) return null;
    const n = m.length + 8;
    return { n, d: qrPath(m, 4) };
  }, [text]);
  if (!svg) return null;
  return (
    <svg
      className="renew-qr"
      viewBox={`0 0 ${svg.n} ${svg.n}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role="img"
      aria-label={t('renew.qrAlt')}
    >
      <rect width={svg.n} height={svg.n} fill="#fff" />
      <path d={svg.d} fill="#000" />
    </svg>
  );
}

/** "Tu cuenta vence en N días" + WhatsApp QR. `state` from renewState(). */
export default function RenewDialog({ open, state, username, onClose }) {
  if (!open || !state) return null;
  const url = renewUrl(username);
  const title = state.expired
    ? t('renew.expired')
    : state.days <= 0
      ? t('renew.today')
      : t('renew.inDays', state.days);
  const openWhatsApp = () => {
    try {
      window.open(url, '_blank', 'noopener');
    } catch {
      window.location.href = url;
    }
  };
  return (
    <div className="exit-overlay renew-overlay" role="dialog" aria-modal="true" aria-labelledby="renew-title">
      <FocusScope trap autoFocus className="exit-dialog renew-dialog">
        <div className="renew-body">
          <div className="renew-text">
            <h2 id="renew-title">{title}</h2>
            {state.date ? <p className="renew-date">{t(state.expired ? 'renew.expiredOn' : 'renew.dateOn', state.date)}</p> : null}
            <p>{t('renew.message')}</p>
            <p className="hint">{t('renew.scan')}</p>
            <div className="exit-actions renew-actions">
              <button tabIndex={0} className="btn-primary btn-lg" data-tv-autofocus="true" onClick={openWhatsApp}>
                {t('renew.whatsapp')}
              </button>
              <button tabIndex={0} className="btn-ghost" data-tv-modal-close="true" onClick={onClose}>
                {state.expired ? t('renew.close') : t('renew.later')}
              </button>
            </div>
          </div>
          <div className="renew-qr-wrap">
            <QrCode text={url} />
            <span className="renew-qr-cap">WhatsApp</span>
          </div>
        </div>
      </FocusScope>
    </div>
  );
}
