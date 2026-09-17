import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { loginWithFailover } from '../lib/dns.js';
import { tryRestoreSession } from '../lib/xtream.js';
import { t, getLang } from '../lib/i18n.js';
import { useSession } from '../context/SessionContext.jsx';
import { serverInfoLabel } from '../lib/accountText.js';
import { setFocused, getTvFocus, openIme, isImeGuarded, markImeOpening } from '../components/Focusable.jsx';
import { getAccount } from '../lib/session.js';

// Login field chain for webOS D-pad: Usuario → Contraseña → Iniciar sesión.
// Modes: default | add (?add=1) | edit (?edit=<accountId>)

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { loginSuccess } = useSession();

  const isAdd = params.get('add') === '1';
  const editId = params.get('edit') || '';
  const isEdit = Boolean(editId);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState({ text: '', kind: '' });
  const [busy, setBusy] = useState(false);
  const attemptRef = useRef(0);
  const userRef = useRef(null);
  const passRef = useRef(null);
  const submitRef = useRef(null);
  const blurTimer = useRef(null);
  const imeOpenRef = useRef(false);
  const navLockRef = useRef(false);

  const fieldOrder = () =>
    [userRef.current, passRef.current, submitRef.current].filter(Boolean);

  const clearBlurTimer = () => {
    if (blurTimer.current) {
      window.clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
  };

  const openFieldIme = (el) => {
    if (!el || el.disabled) return;
    navLockRef.current = true; // block blur restore while keyboard opens
    imeOpenRef.current = true;
    markImeOpening(el, 800);
    clearBlurTimer();
    openIme(el);
    window.setTimeout(() => {
      navLockRef.current = false;
    }, 850);
  };

  // Mouse / remote click sometimes focuses without raising the IME — nudge it.
  const onFieldPointer = (el) => {
    if (!el || el.disabled) return;
    markImeOpening(el, 800);
    window.setTimeout(() => {
      if (document.activeElement === el) {
        try {
          const kb = window.webOS && window.webOS.keyboard;
          if (kb && typeof kb.show === 'function') kb.show();
        } catch {
          /* ignore */
        }
        try {
          if (window.PalmSystem && typeof window.PalmSystem.keyboardShow === 'function') {
            window.PalmSystem.keyboardShow(1);
          }
        } catch {
          /* ignore */
        }
      } else {
        openFieldIme(el);
      }
    }, 40);
  };

  const onFieldBlur = (el) => {
    // webOS often fires a transient blur while raising the IME — ignore it.
    if (isImeGuarded(el) || navLockRef.current) return;
    clearBlurTimer();
    blurTimer.current = window.setTimeout(() => {
      blurTimer.current = null;
      if (isImeGuarded(el) || navLockRef.current) return;
      // Still natively focused → IME is up; keep ring, don't fight it.
      if (document.activeElement === el) {
        imeOpenRef.current = true;
        setFocused(el, { native: false });
        return;
      }
      imeOpenRef.current = false;
      const painted = getTvFocus();
      if (painted && painted !== el) return;
      const active = document.activeElement;
      const stillInForm =
        active &&
        (active === userRef.current ||
          active === passRef.current ||
          active === submitRef.current);
      if (stillInForm) {
        setFocused(active, { native: false });
        return;
      }
      if (el && el.isConnected) setFocused(el, { native: false });
    }, 120);
  };

  const onFieldFocus = (el) => {
    clearBlurTimer();
    imeOpenRef.current = true;
    if (isImeGuarded(el)) {
      setFocused(el, { native: false });
      return;
    }
    navLockRef.current = false;
    setFocused(el, { native: false });
  };

  const moveTo = (next) => {
    if (!next) return;
    navLockRef.current = true;
    clearBlurTimer();
    imeOpenRef.current = false;
    if (document.activeElement && isLoginInput(document.activeElement)) {
      try {
        document.activeElement.blur();
      } catch {
        /* ignore */
      }
    }
    setFocused(next, { native: false });
    window.setTimeout(() => {
      navLockRef.current = false;
    }, 200);
  };

  const onFieldKeyDown = (e, index) => {
    const code = e.keyCode || e.which || 0;
    const down = e.key === 'ArrowDown' || e.key === 'Down' || code === 40;
    const up = e.key === 'ArrowUp' || e.key === 'Up' || code === 38;
    const enter =
      e.key === 'Enter' ||
      e.key === 'Select' ||
      e.key === 'Accept' ||
      code === 13 ||
      code === 23;
    const remoteBack =
      e.key === 'Escape' ||
      e.key === 'BrowserBack' ||
      e.key === 'GoBack' ||
      code === 461 ||
      code === 27;
    const isBs = e.key === 'Backspace' || code === 8;

    const fields = fieldOrder();
    const current = fields[index];

    // While the IME has the input focused, Backspace must delete characters —
    // only the TV Back key (461) / Escape closes the keyboard.
    if (isBs && isLoginInput(current) && document.activeElement === current) {
      return;
    }

    if (remoteBack && isLoginInput(current)) {
      e.preventDefault();
      e.stopPropagation();
      clearBlurTimer();
      navLockRef.current = true;
      imeOpenRef.current = false;
      try {
        current.blur();
      } catch {
        /* ignore */
      }
      setFocused(current, { native: false });
      window.setTimeout(() => {
        navLockRef.current = false;
      }, 200);
      return;
    }

    if (enter && current && isLoginInput(current)) {
      // Already typing — don't re-openIme (second kick can dismiss webOS IME).
      if (document.activeElement === current) return;
      e.preventDefault();
      e.stopPropagation();
      openFieldIme(current);
      return;
    }

    if (!down && !up) return;
    if (!fields.length) return;
    e.preventDefault();
    e.stopPropagation();

    const nextIndex = down
      ? Math.min(index + 1, fields.length - 1)
      : Math.max(index - 1, 0);
    moveTo(fields[nextIndex]);
  };

  useEffect(() => {
    if (!isEdit) return;
    const acc = getAccount(editId);
    if (!acc) return;
    setUsername(acc.username || '');
    setPassword(acc.password || '');
  }, [isEdit, editId]);

  useEffect(() => {
    const kick = () => setFocused(userRef.current, { native: false });
    const t1 = window.setTimeout(kick, 40);
    const t2 = window.setTimeout(() => {
      if (!getTvFocus() || getTvFocus() !== userRef.current) kick();
    }, 250);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      clearBlurTimer();
    };
  }, []);

  useEffect(() => {
    if (isAdd || isEdit) return undefined;
    let cancelled = false;
    (async () => {
      const res = await tryRestoreSession();
      if (cancelled) return;
      if (res && res.ok) {
        loginSuccess(res);
        navigate('/', { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdd, isEdit]);

  const leaveLogin = () => {
    if (isAdd || isEdit) navigate('/accounts');
    else navigate(-1);
  };

  const doLogin = async () => {
    if (busy) return;
    const u = username.trim();
    const p = password;
    if (!u || !p) {
      setStatus({ text: t('login.empty'), kind: 'err' });
      const target = u ? passRef.current : userRef.current;
      openFieldIme(target);
      return;
    }
    setBusy(true);
    setStatus({ text: t('login.findingServer'), kind: '' });
    const my = ++attemptRef.current;
    const result = await loginWithFailover(u, p);

    if (my !== attemptRef.current) return;
    setBusy(false);

    if (result.ok) {
      loginSuccess(result);
      setStatus({ text: t('login.success'), kind: 'ok' });
      setTimeout(() => navigate('/', { replace: true }), 350);
    } else if (result.reason === 'empty') {
      setStatus({ text: t('login.empty'), kind: 'err' });
    } else if (result.reason === 'account') {
      setStatus({ text: serverInfoLabel(result.status), kind: 'err' });
    } else {
      // eslint-disable-next-line no-console
      console.warn('[login] all servers failed', result.results);
      const blocked = (result.results || []).filter((r) => r.httpStatus === 403).length;
      const text =
        blocked && blocked === (result.results || []).length
          ? t('login.blocked')
          : t('login.failed');
      setStatus({ text, kind: 'err' });
      setFocused(submitRef.current, { native: false });
    }
  };

  const titleHint = isEdit
    ? t('accounts.editHint')
    : isAdd
      ? t('accounts.addHint')
      : t('login.typeHint');

  return (
    <div className="login-wrap">
      <form
        className="login-card"
        data-focus-scope="trap"
        onSubmit={(e) => {
          e.preventDefault();
          doLogin();
        }}
      >
        {(isAdd || isEdit) && (
          <button
            type="button"
            tabIndex={0}
            className="back-btn"
            style={{ alignSelf: 'flex-start', marginBottom: 8 }}
            onClick={leaveLogin}
          >
            ← {t('common.back')}
          </button>
        )}
        <h1>{t('appName')}</h1>
        <p className="login-hint">{titleHint}</p>

        <label htmlFor="login-user">
          {t('login.username')}
          <input
            id="login-user"
            ref={userRef}
            type="text"
            inputMode="text"
            enterKeyHint="next"
            tabIndex={0}
            data-focusable="true"
            data-input="true"
            data-login-field="user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onFocus={() => onFieldFocus(userRef.current)}
            onBlur={() => onFieldBlur(userRef.current)}
            onKeyDown={(e) => onFieldKeyDown(e, 0)}
            onMouseDown={() => markImeOpening(userRef.current, 800)}
            onClick={() => onFieldPointer(userRef.current)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            readOnly={false}
            placeholder={t('login.pressOkType')}
            disabled={busy}
            style={{ pointerEvents: 'auto' }}
          />
        </label>

        <label htmlFor="login-pass">
          {t('login.password')}
          <input
            id="login-pass"
            ref={passRef}
            type="password"
            inputMode="text"
            enterKeyHint="done"
            tabIndex={0}
            data-focusable="true"
            data-input="true"
            data-login-field="pass"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onFocus={() => onFieldFocus(passRef.current)}
            onBlur={() => onFieldBlur(passRef.current)}
            onKeyDown={(e) => onFieldKeyDown(e, 1)}
            onMouseDown={() => markImeOpening(passRef.current, 800)}
            onClick={() => onFieldPointer(passRef.current)}
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            readOnly={false}
            placeholder={t('login.pressOkType')}
            disabled={busy}
            style={{ pointerEvents: 'auto' }}
          />
        </label>

        <div className="login-actions">
          <button
            ref={submitRef}
            tabIndex={0}
            data-focusable="true"
            data-login-field="submit"
            type="submit"
            className="btn-primary"
            disabled={busy}
            onFocus={() => onFieldFocus(submitRef.current)}
            onBlur={() => onFieldBlur(submitRef.current)}
            onKeyDown={(e) => onFieldKeyDown(e, 2)}
          >
            {t('login.signIn')}
          </button>
        </div>

        <p className={`login-status ${status.kind}`}>{status.text}</p>
        <p className="login-hint">
          {getLang() === 'es' ? t('login.languageHint') : t('login.languageHint')}
        </p>
      </form>
    </div>
  );
}

function isLoginInput(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}
