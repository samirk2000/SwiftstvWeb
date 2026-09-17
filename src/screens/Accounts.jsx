import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import {
  listAccounts,
  removeAccount,
  getSession,
  accountIdFor,
  ensureActiveAccountListed,
} from '../lib/session.js';
import { login } from '../lib/xtream.js';
import { useSession } from '../context/SessionContext.jsx';
import { FocusScope, useFocusable } from '../components/Focusable.jsx';

function AccountRow({ account, active, busyId, onSwitch, onEdit, onDelete }) {
  const row = useFocusable(`acc-${account.id}`);
  const editBtn = useFocusable(`acc-edit-${account.id}`);
  const delBtn = useFocusable(`acc-del-${account.id}`);
  const switching = busyId === account.id;

  return (
    <div
      ref={row.ref}
      tabIndex={row.tabIndex}
      className={`account-row ${active ? 'active' : ''} ${switching ? 'busy' : ''}`}
      data-focusable="true"
      onClick={() => onSwitch(account)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onSwitch(account);
        }
      }}
    >
      <div className="account-main">
        <div className="account-label">
          {account.label || account.username}
          {active ? <span className="account-badge">{t('accounts.active')}</span> : null}
        </div>
        <div className="account-meta">
          <span>{account.username}</span>
          <span className="account-host">{account.host || account.baseUrl}</span>
        </div>
        {switching ? <div className="hint">{t('accounts.switching')}</div> : null}
      </div>
      <div className="account-actions" onClick={(e) => e.stopPropagation()}>
        <button
          ref={editBtn.ref}
          tabIndex={editBtn.tabIndex}
          className="btn-ghost btn-xs"
          onClick={() => onEdit(account)}
        >
          {t('accounts.edit')}
        </button>
        <button
          ref={delBtn.ref}
          tabIndex={delBtn.tabIndex}
          className="btn-ghost btn-xs"
          onClick={() => onDelete(account)}
        >
          {t('accounts.delete')}
        </button>
      </div>
    </div>
  );
}

export default function Accounts() {
  const navigate = useNavigate();
  const { loginSuccess, accountsTick, bumpAccounts, logout } = useSession();
  const [tick, setTick] = useState(0);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [confirmDel, setConfirmDel] = useState(null);

  useEffect(() => {
    ensureActiveAccountListed();
    setTick((x) => x + 1);
  }, [accountsTick]);

  const accounts = useMemo(() => listAccounts(), [tick, accountsTick]);
  const active = getSession();
  const activeId = active
    ? accountIdFor(active.baseUrl, active.username)
    : '';

  const refresh = () => {
    bumpAccounts?.();
    setTick((x) => x + 1);
  };

  const onSwitch = useCallback(
    async (account) => {
      if (!account || busyId) return;
      if (account.id === activeId) {
        navigate('/', { replace: true });
        return;
      }
      setError('');
      setBusyId(account.id);
      try {
        const result = await login({
          baseUrl: account.baseUrl,
          username: account.username,
          password: account.password,
        });
        if (result?.ok) {
          loginSuccess({
            ...result,
            workingBaseUrl: result.session?.baseUrl || account.baseUrl,
          });
          navigate('/', { replace: true });
        } else {
          setError(t('accounts.switchFailed'));
          setBusyId('');
        }
      } catch {
        setError(t('accounts.switchFailed'));
        setBusyId('');
      }
    },
    [activeId, busyId, loginSuccess, navigate]
  );

  const onEdit = (account) => {
    navigate(`/login?edit=${encodeURIComponent(account.id)}`);
  };

  const onAdd = () => {
    navigate('/login?add=1');
  };

  const onDelete = (account) => {
    setConfirmDel(account);
  };

  const confirmDelete = () => {
    if (!confirmDel) return;
    const id = confirmDel.id;
    const wasActive = id === activeId;
    removeAccount(id);
    setConfirmDel(null);
    refresh();
    if (wasActive) {
      logout();
      navigate('/login', { replace: true });
    }
  };

  return (
    <div>
      <div className="page-head">
        <button tabIndex={0} className="back-btn" onClick={() => navigate(-1)}>
          ← {t('common.back')}
        </button>
        <h1>{t('accounts.title')}</h1>
      </div>

      <p className="hint">{t('accounts.hint')}</p>

      {error ? <p className="login-status err">{error}</p> : null}

      <div className="detail-actions" style={{ marginBottom: 16 }}>
        <button tabIndex={0} className="btn-primary" onClick={onAdd}>
          + {t('accounts.add')}
        </button>
      </div>

      {!accounts.length ? (
        <div className="state">{t('accounts.empty')}</div>
      ) : (
        <div className="account-list">
          {accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              active={a.id === activeId}
              busyId={busyId}
              onSwitch={onSwitch}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}

      {confirmDel ? (
        <div className="exit-overlay" role="dialog" aria-modal="true">
          <FocusScope trap autoFocus className="exit-dialog">
            <h2>{t('accounts.deleteTitle')}</h2>
            <p>
              {t('accounts.deleteMsg')}{' '}
              <strong>{confirmDel.label || confirmDel.username}</strong>
            </p>
            <div className="exit-actions">
              <button
                tabIndex={0}
                className="btn-primary"
                data-focusable="true"
                onClick={() => setConfirmDel(null)}
              >
                {t('common.no')}
              </button>
              <button
                tabIndex={0}
                className="btn-ghost"
                data-focusable="true"
                onClick={confirmDelete}
              >
                {t('accounts.delete')}
              </button>
            </div>
          </FocusScope>
        </div>
      ) : null}
    </div>
  );
}
