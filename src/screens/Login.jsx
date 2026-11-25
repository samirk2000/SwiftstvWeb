import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { loginWithFailover } from '../lib/dns.js';
import { tryRestoreSession } from '../lib/xtream.js';
import { t, getLang } from '../lib/i18n.js';
import { useSession } from '../context/SessionContext.jsx';
import { serverInfoLabel } from '../lib/accountText.js';
import {
  setFocused,
  getTvFocus,
  openIme,
  isImeGuarded,
  markImeOpening,
  clearImeGuard,
  useFocusable,
} from '../components/Focusable.jsx';
import { getAccount, listAccounts } from '../lib/session.js';
import BrandLogo from '../components/BrandLogo.jsx';

// Modes: picker (saved accounts) | form (user/pass). DNS is always failover —
// the user never picks a server. Query: ?add=1 | ?edit=<accountId> | ?form=1

function SavedAccountRow({ account, busyId, onPick }) {
  const row = useFocusable(`login-acc-${account.id}`);
  const switching = busyId === account.id;
  return (
    <button
      type="button"
      ref={row.ref}
      tabIndex={row.tabIndex}
      className={`login-account-row ${switching ? 'busy' : ''}`}
      data-focusable="true"
      disabled={Boolean(busyId)}
      onClick={() => onPick(account)}
    >
      <span className="login-account-name">{account.label || account.username}</span>
      {switching ? <span className="hint">{t('accounts.switching')}</span> : null}
    </button>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { loginSuccess } = useSession();

  const isAdd = params.get('add') === '1';
  const forceForm = params.get('form') === '1';
  const editId = params.get('edit') || '';
  const isEdit = Boolean(editId);

  const [phase, setPhase] = useState(() =>
    isAdd || isEdit || forceForm ? 'form' : 'boot'
  );
  const [accounts, setAccounts] = useState(() => listAccounts());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState({ text: '', kind: '' });
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState('');
  const attemptRef = useRef(0);
  const userRef = useRef(null);
  const passRef = useRef(null);
  const submitRef = useRef(null);
  const addBtn = useFocusable('login-add-account');
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
    navLockRef.current = true;
    imeOpenRef.current = true;
    markImeOpening(el, 800);
    clearBlurTimer();
    openIme(el);
    window.setTimeout(() => {
      navLockRef.current = false;
    }, 850);
  };

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
    if (isImeGuarded(el) || navLockRef.current) return;
    clearBlurTimer();
    blurTimer.current = window.setTimeout(() => {
      blurTimer.current = null;
      if (isImeGuarded(el) || navLockRef.current) return;
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
      e.key === 'XF86Back' ||
      code === 10009 ||
      code === 27;
    const isBs = e.key === 'Backspace' || code === 8;

    const fields = fieldOrder();
    const current = fields[index];

    if (isBs && isLoginInput(current) && document.activeElement === current) {
      return;
    }

    if (remoteBack && isLoginInput(current)) {
      e.preventDefault();
      e.stopPropagation();
      clearBlurTimer();
      navLockRef.current = true;
      imeOpenRef.current = false;
      clearImeGuard();
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
    setPhase('form');
  }, [isEdit, editId]);

  useEffect(() => {
    if (isAdd || isEdit || forceForm) {
      setPhase('form');
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const res = await tryRestoreSession();
      if (cancelled) return;
      if (res && res.ok) {
        loginSuccess(res);
        navigate('/', { replace: true });
        return;
      }
      const list = listAccounts();
      setAccounts(list);
      setPhase(list.length ? 'picker' : 'form');
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdd, isEdit, forceForm]);

  useEffect(() => {
    if (phase !== 'form') return undefined;
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
  }, [phase]);

  useEffect(() => {
    if (phase !== 'picker') return undefined;
    const first = document.querySelector('[data-focusable="true"].login-account-row');
    const t1 = window.setTimeout(() => {
      setFocused(first || addBtn.ref.current, { native: false });
    }, 60);
    return () => window.clearTimeout(t1);
  }, [phase, accounts, addBtn.ref]);

  const applyLoginResult = (result) => {
    if (result.ok) {
      loginSuccess(result);
      setStatus({ text: t('login.success'), kind: 'ok' });
      setTimeout(() => navigate('/', { replace: true }), 350);
      return true;
    }
    if (result.reason === 'empty') {
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
    }
    return false;
  };

  const pickAccount = async (account) => {
    if (!account || busyId || busy) return;
    setStatus({ text: t('login.findingServer'), kind: '' });
    setBusyId(account.id);
    const my = ++attemptRef.current;
    const result = await loginWithFailover(account.username, account.password);
    if (my !== attemptRef.current) return;
    setBusyId('');
    if (!applyLoginResult(result)) {
      setFocused(
        document.querySelector(`[data-focus-key="login-acc-${account.id}"]`) ||
          document.querySelector('.login-account-row'),
        { native: false }
      );
    }
  };

  const leaveLogin = () => {
    if (isAdd || isEdit) {
      navigate('/accounts');
      return;
    }
    const list = listAccounts();
    if (list.length && phase === 'form') {
      setAccounts(list);
      setStatus({ text: '', kind: '' });
      setPhase('picker');
      return;
    }
    navigate(-1);
  };

  const openNewAccountForm = () => {
    setUsername('');
    setPassword('');
    setStatus({ text: '', kind: '' });
    setPhase('form');
  };

  const doLogin = async () => {
    if (busy || busyId) return;
    const u = username.trim();
    const p = password;
    if (!u || !p) {
      const target = u ? passRef.current : userRef.current;
      setStatus({ text: t('login.pressOkType'), kind: '' });
      openFieldIme(target);
      return;
    }
    setBusy(true);
    setStatus({ text: t('login.findingServer'), kind: '' });
    const my = ++attemptRef.current;
    const result = await loginWithFailover(u, p);

    if (my !== attemptRef.current) return;
    setBusy(false);

    if (!applyLoginResult(result)) {
      setFocused(submitRef.current, { native: false });
    }
  };

  const titleHint = isEdit
    ? t('accounts.editHint')
    : isAdd || phase === 'form'
      ? accounts.length || isAdd
        ? t('accounts.addHint')
        : t('login.typeHint')
      : t('login.typeHint');

  if (phase === 'boot') {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-brand">
            <BrandLogo size="lg" />
            <h1 className="login-brand-name">{t('appName')}</h1>
          </div>
          <p className="login-status">{t('login.findingServer')}</p>
        </div>
      </div>
    );
  }

  if (phase === 'picker') {
    return (
      <div className="login-wrap">
        <div className="login-card login-picker" data-focus-scope="trap">
          <div className="login-brand">
            <BrandLogo size="lg" />
            <h1 className="login-brand-name">{t('appName')}</h1>
            <p className="login-brand-tag">{t('brandTagline')}</p>
          </div>
          <p className="login-hint">{t('accounts.pickHint')}</p>
          <div className="login-account-list">
            {accounts.map((a) => (
              <SavedAccountRow
                key={a.id}
                account={a}
                busyId={busyId}
                onPick={pickAccount}
              />
            ))}
          </div>
          <div className="login-actions">
            <button
              type="button"
              ref={addBtn.ref}
              tabIndex={addBtn.tabIndex}
              className="btn-primary"
              data-focusable="true"
              disabled={Boolean(busyId)}
              onClick={openNewAccountForm}
            >
              + {t('accounts.add')}
            </button>
          </div>
          {status.text ? (
            <p className={`login-status ${status.kind}`}>{status.text}</p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form
        className="login-card"
        data-focus-scope="trap"
        onSubmit={(e) => {
          e.preventDefault();
          const painted = getTvFocus();
          if (painted === passRef.current && !password) {
            openFieldIme(passRef.current);
            return;
          }
          if (painted === userRef.current && !username.trim()) {
            openFieldIme(userRef.current);
            return;
          }
          doLogin();
        }}
      >
        {(isAdd || isEdit || accounts.length > 0) && (
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
        <div className="login-brand">
          <BrandLogo size="lg" />
          <h1 className="login-brand-name">{t('appName')}</h1>
          <p className="login-brand-tag">{t('brandTagline')}</p>
        </div>
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
