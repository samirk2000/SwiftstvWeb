import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getLiveCategories, getVodCategories, getSeriesCategories } from '../lib/xtream.js';
import {
  getParentalState,
  upsertProfile,
  deleteProfile,
  setActiveProfile,
  getActiveProfile,
  verifyPin,
} from '../lib/parental.js';
import { useSession } from '../context/SessionContext.jsx';
import { useFocusable } from '../components/Focusable.jsx';

// A focusable toggle chip that adds/removes a category id from the blocked set.
function BlockChip({ cat, blocked, onToggle }) {
  const { ref, tabIndex } = useFocusable(`par-cat-${cat.category_id}-${blocked}`, false);
  const on = blocked.has(String(cat.category_id));
  return (
    <button
      className={`cat-chip ${on ? 'selected' : ''}`}
      onClick={() => onToggle(cat)}
    >
      {on ? '🔒 ' : ''}
      {cat.category_name}
    </button>
  );
}

export default function Parental() {
  const navigate = useNavigate();
  const { session } = useSession();

  const [state, setState] = useState(() => getParentalState());
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [unlockKey, setUnlockKey] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');

  const profiles = useMemo(() => state.profiles || [], [state]);
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === state.active) || null,
    [profiles, state.active]
  );

  // Categories available to lock (live + vod + series).
  const [cats, setCats] = useState([]);
  useEffect(() => {
    const saved = getStoredSession();
    if (!saved) return;
    const srv = { baseUrl: saved.baseUrl, username: saved.username, password: saved.password };
    Promise.all([
      getLiveCategories(srv).catch(() => []),
      getVodCategories(srv).catch(() => []),
      getSeriesCategories(srv).catch(() => []),
    ])
      .then(([l, v, s]) =>
        setCats([
          ...l.map((c) => ({ ...c, scope: 'live' })),
          ...v.map((c) => ({ ...c, scope: 'vod' })),
          ...s.map((c) => ({ ...c, scope: 'series' })),
        ])
      )
      .catch(() => setCats([]));
  }, [session]);

  const refresh = useCallback(() => setState(getParentalState()), []);

  const savePin = () => {
    if (!pin) return;
    if (pin !== confirmPin) {
      setError(t('parental.pinMismatch'));
      return;
    }
    // Keep the active blocked list; if the profile exists, retain what was set.
    const existing = activeProfile || null;
    const id = existing ? existing.id : `profile-${Date.now()}`;
    upsertProfile({
      id,
      name: existing?.name || t('parental.profile'),
      pin,
      blockedCategoryIds: existing?.blockedCategoryIds || [],
    });
    setPin('');
    setConfirmPin('');
    setShowForm(false);
    setError('');
    refresh();
  };

  const verifyUnlock = () => {
    if (verifyPin(unlockKey)) {
      setUnlockKey('');
      setShowForm(true);
      setError('');
    } else {
      setError(t('parental.pinWrong'));
    }
  };

  const toggleBlock = (cat) => {
    if (!activeProfile) return;
    const blocked = new Set((activeProfile.blockedCategoryIds || []).map(String));
    const id = String(cat.category_id);
    if (blocked.has(id)) blocked.delete(id);
    else blocked.add(id);
    upsertProfile({ ...activeProfile, blockedCategoryIds: [...blocked] });
    refresh();
  };

  const unlockAll = () => {
    if (!activeProfile) return;
    upsertProfile({ ...activeProfile, blockedCategoryIds: [] });
    refresh();
  };

  function getStoredSession() {
    // Avoid circular import from xtream; just read localStorage directly.
    try {
      const raw = localStorage.getItem('swiftstv.session.v1');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  return (
    <div>
      <div className="page-head">
        <button className="back-btn" onClick={() => navigate(-1)}>
          ← {t('common.back')}
        </button>
        <h1>{t('home.parental')}</h1>
      </div>

      <p className="login-hint">{t('parental.hint')}</p>

      {!activeProfile && !showForm ? (
        <div className="parental-card">
          <button className="btn-primary" onClick={() => setShowForm(true)}>
            {t('parental.setPin')}
          </button>
        </div>
      ) : null}

      {activeProfile && !showForm ? (
        <div className="parental-card">
          <p>
            {t('parental.profile')}: <strong>{activeProfile.name}</strong>
          </p>
          <input
            className="search-box pin-input"
            type="password"
            inputMode="numeric"
            placeholder={t('parental.enterPin')}
            value={unlockKey}
            onChange={(e) => setUnlockKey(e.target.value)}
          />
          <button className="btn-ghost" onClick={verifyUnlock}>
            {t('parental.edit')}
          </button>
          <button
            className="btn-ghost"
            onClick={() => {
              setActiveProfile('');
              refresh();
            }}
          >
            {t('parental.disable')}
          </button>
        </div>
      ) : null}

      {showForm && (
        <div className="parental-card">
          <input
            className="search-box pin-input"
            type="password"
            inputMode="numeric"
            placeholder={t('parental.newPin')}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          <input
            className="search-box pin-input"
            type="password"
            inputMode="numeric"
            placeholder={t('parental.confirmPin')}
            value={confirmPin}
            onChange={(e) => setConfirmPin(e.target.value)}
          />
          <div className="detail-actions">
            <button className="btn-primary" onClick={savePin}>
              {t('parental.save')}
            </button>
            <button className="btn-ghost" onClick={() => setShowForm(false)}>
              {t('common.back')}
            </button>
          </div>
          {activeProfile && (
            <button
              className="btn-ghost"
              onClick={() => {
                if (activeProfile) deleteProfile(activeProfile.id);
                setShowForm(false);
                setPin('');
                setConfirmPin('');
                refresh();
              }}
            >
              {t('parental.removeProfile')}
            </button>
          )}
        </div>
      )}

      {error && <p className="login-status err">{error}</p>}

      {activeProfile && showForm && (
        <>
          <h2 className="row-title">{t('parental.blockedCategories')}</h2>
          <button className="btn-ghost" onClick={unlockAll}>
            {t('parental.unlockAll')}
          </button>
          <div className="cat-bar wrap">
            {cats.map((cat) => (
              <BlockChip
                key={`${cat.scope}-${cat.category_id}`}
                cat={cat}
                blocked={new Set((activeProfile.blockedCategoryIds || []).map(String))}
                onToggle={toggleBlock}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
