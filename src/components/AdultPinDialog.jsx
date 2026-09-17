import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import {
  applyAdultPinResult,
  hasAdultPin,
  PinResult,
  verifyAdultPin,
} from '../lib/parental.js';
import { FocusScope, setFocused } from './Focusable.jsx';

/**
 * Adult PIN dialog — Android ParentalPinDialog parity.
 * creating=true when no PIN exists yet (first adult entry).
 * Master PIN 0000 is NEVER mentioned in the UI.
 */
export default function AdultPinDialog({ open, creating, onUnlocked, onDismiss }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const isCreating = creating ?? !hasAdultPin();

  useEffect(() => {
    if (!open) {
      delete document.documentElement.dataset.tvAdultPin;
      return undefined;
    }
    document.documentElement.dataset.tvAdultPin = '1';
    setPin('');
    setError('');
    const timers = [50, 200, 450].map((ms) =>
      window.setTimeout(() => {
        if (inputRef.current) setFocused(inputRef.current, { native: true });
      }, ms),
    );
    return () => {
      delete document.documentElement.dataset.tvAdultPin;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const result = verifyAdultPin(pin);
    if (result === PinResult.Invalid) {
      setError(t('parental.pinWrong'));
      setPin('');
      return;
    }
    applyAdultPinResult(result, pin);
    onUnlocked?.(result);
  };

  return (
    <div className="exit-overlay adult-pin-overlay" role="dialog" aria-modal="true">
      <FocusScope trap autoFocus className="exit-dialog adult-pin-dialog">
        <h2>{isCreating ? t('parental.createAdultPin') : t('parental.enterAdultPin')}</h2>
        <p className="hint">{isCreating ? t('parental.createAdultPinHint') : t('parental.enterAdultPinHint')}</p>
        <input
          ref={inputRef}
          tabIndex={0}
          className="search-box pin-input"
          type="password"
          inputMode="numeric"
          maxLength={4}
          autoComplete="off"
          value={pin}
          placeholder="••••"
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 4);
            setPin(v);
            setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && pin.length === 4) {
              e.preventDefault();
              submit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              onDismiss?.();
            }
          }}
        />
        {error ? <p className="login-status err">{error}</p> : null}
        <div className="exit-actions">
          <button tabIndex={0} className="btn-ghost" onClick={() => onDismiss?.()}>
            {t('common.back')}
          </button>
          <button
            tabIndex={0}
            className="btn-primary"
            disabled={pin.length !== 4}
            onClick={submit}
          >
            OK
          </button>
        </div>
        <p className="hint adult-pin-help">{t('parental.pinHelp')}</p>
      </FocusScope>
    </div>
  );
}
