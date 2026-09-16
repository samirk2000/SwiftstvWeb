import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loginWithFailover } from '../lib/dns.js';
import { tryRestoreSession } from '../lib/xtream.js';
import { t, getLang } from '../lib/i18n.js';
import { useSession } from '../context/SessionContext.jsx';
import { serverInfoLabel } from '../lib/accountText.js';
import { setTvFocus, getTvFocus, openIme } from '../components/Focusable.jsx';

// Login field chain for webOS D-pad: Usuario → Contraseña → Iniciar sesión.
// Virtual cyan ring moves with arrows; OK calls openIme() so webOS shows the
// native keyboard. On IME dismiss (blur) we restore virtual focus only.

export default function Login() {
  const navigate = useNavigate();
  const { loginSuccess } = useSession();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState({ text: '', kind: '' });
  const [busy, setBusy] = useState(false);
  const attemptRef = useRef(0);
  const userRef = useRef(null);
  const passRef = useRef(null);
  const submitRef = useRef(null);
  const blurTimer = useRef(null);
  // True while we intentionally opened the IME — blur then restores virtual ring.
  const imeOpenRef = useRef(false);

  const fieldOrder = () =>
    [userRef.current, passRef.current, submitRef.current].filter(Boolean);

  const paintField = (el, { native = false } = {}) => {
    if (!el) return;
    setTvFocus(el, { native });
  };

  const openFieldIme = (el) => {
    if (!el || el.disabled) return;
    imeOpenRef.current = true;
    openIme(el);
  };

  // After IME hide / blur: keep cyan on the same field (virtual only).
  const onFieldBlur = (el) => {
    if (blurTimer.current) window.clearTimeout(blurTimer.current);
    blurTimer.current = window.setTimeout(() => {
      const active = document.activeElement;
      const stillInForm =
        active &&
        (active === userRef.current ||
          active === passRef.current ||
          active === submitRef.current);
      if (stillInForm) {
        imeOpenRef.current = false;
        paintField(active, { native: false });
        return;
      }
      // IME closed → body/html. Restore virtual selection on the blurred field.
      imeOpenRef.current = false;
      if (el && el.isConnected) {
        try {
          el.blur();
        } catch {
          /* ignore */
        }
        paintField(el, { native: false });
      }
    }, 80);
  };

  const onFieldFocus = (el) => {
    if (blurTimer.current) window.clearTimeout(blurTimer.current);
    // Mirror ring; if focus came from OK/openIme keep imeOpen flag.
    paintField(el, { native: false });
  };

  // Up/Down: field chain. Enter/OK on inputs: open IME.
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

    const fields = fieldOrder();
    const current = fields[index];

    if (enter && current && isLoginInput(current)) {
      // If IME already has native focus, let the key type / confirm.
      if (document.activeElement === current && imeOpenRef.current) return;
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
    const next = fields[nextIndex];
    if (!next) return;

    imeOpenRef.current = false;
    if (document.activeElement && isLoginInput(document.activeElement)) {
      try {
        document.activeElement.blur();
      } catch {
        /* ignore */
      }
    }
    paintField(next, { native: false });
  };

  useEffect(() => {
    const t1 = window.setTimeout(() => paintField(userRef.current, { native: false }), 60);
    const t2 = window.setTimeout(() => {
      if (!getTvFocus()) paintField(userRef.current, { native: false });
    }, 300);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      if (blurTimer.current) window.clearTimeout(blurTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
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
  }, []);

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
      paintField(submitRef.current, { native: false });
    }
  };

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
        <h1>{t('appName')}</h1>
        <p className="login-hint">{t('login.typeHint')}</p>

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
