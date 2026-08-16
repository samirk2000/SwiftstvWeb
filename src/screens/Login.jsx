import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loginWithFailover } from '../lib/dns.js';
import { tryRestoreSession } from '../lib/xtream.js';
import { t, getLang } from '../lib/i18n.js';
import { useSession } from '../context/SessionContext.jsx';
import { serverInfoLabel } from '../lib/accountText.js';

// D-pad style: the three fields (user / pass / submit) are navigable with
// arrows + Enter. Inputs are real <input> so the TV OS keyboard/remote typing
// works; our global key handler lets text fields keep their arrow keys.
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

  // Auto-restore a saved session on mount; go straight to Home when valid.
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
      (u ? passRef.current : userRef.current)?.focus();
      return;
    }
    setBusy(true);
    setStatus({ text: t('login.findingServer'), kind: '' });
    const my = ++attemptRef.current;
    const result = await loginWithFailover(u, p);

    if (my !== attemptRef.current) return; // superseded
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
      // Network / blocked (proxy WAF) — show an honest, diagnosable message.
      // eslint-disable-next-line no-console
      console.warn('[login] all servers failed', result.results);
      const blocked = (result.results || []).filter((r) => r.httpStatus === 403).length;
      const text = blocked && blocked === (result.results || []).length
        ? t('login.blocked')
        : t('login.failed');
      setStatus({ text, kind: 'err' });
    }
  };

  return (
    <div className="login-wrap">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          doLogin();
        }}
      >
        <h1>{t('appName')}</h1>
        <p className="login-hint">{t('login.typeHint')}</p>

        <label>
          {t('login.username')}
          <input
            ref={userRef}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            placeholder={t('login.pressOkType')}
            disabled={busy}
          />
        </label>

        <label>
          {t('login.password')}
          <input
            ref={passRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder={t('login.pressOkType')}
            disabled={busy}
          />
        </label>

        <div className="login-actions">
          <button ref={submitRef} type="submit" className="btn-primary" disabled={busy}>
            {t('login.signIn')}
          </button>
        </div>

        <p className={`login-status ${status.kind}`}>{status.text}</p>
        <p className="login-hint">{getLang() === 'es' ? t('login.languageHint') : t('login.languageHint')}</p>
      </form>
    </div>
  );
}
