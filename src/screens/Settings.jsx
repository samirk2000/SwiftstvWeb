import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getActiveProfile, upsertProfile, verifyPin } from '../lib/parental.js';
import { useSession } from '../context/SessionContext.jsx';
import { FocusScope } from '../components/Focusable.jsx';
import { getPrefs, setPrefs } from '../lib/prefs.js';

export default function Settings() {
  const navigate = useNavigate();
  const { lang, toggleLanguage } = useSession();
  const [prefs, setPrefsState] = useState(() => getPrefs());

  const profile = getActiveProfile();
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinMsg, setPinMsg] = useState({ text: '', kind: '' });
  const [toast, setToast] = useState('');

  const flash = (text) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 1800);
  };

  const patchPrefs = (patch) => {
    const next = setPrefs(patch);
    setPrefsState(next);
    flash(t('settings.saved'));
  };

  const savePin = () => {
    const hasPin = Boolean(profile?.pin);
    if (hasPin && !verifyPin(currentPin)) {
      setPinMsg({ text: t('parental.pinWrong'), kind: 'err' });
      return;
    }
    if (!newPin || newPin !== confirmPin) {
      setPinMsg({ text: t('parental.pinMismatch'), kind: 'err' });
      return;
    }
    upsertProfile({
      id: profile?.id || `profile-${Date.now()}`,
      name: profile?.name || t('parental.profile'),
      pin: newPin,
      blockedCategoryIds: profile?.blockedCategoryIds || [],
    });
    setCurrentPin('');
    setNewPin('');
    setConfirmPin('');
    setPinMsg({ text: t('settings.saved'), kind: 'ok' });
  };

  const setLang = (next) => {
    if (next !== lang) toggleLanguage();
  };

  return (
    <FocusScope trap autoFocus className="settings-scope">
      <div className="page-head">
        <button tabIndex={0} className="back-btn" onClick={() => navigate(-1)}>
          ← {t('common.back')}
        </button>
        <h1>{t('settings.title')}</h1>
      </div>

      {toast ? <p className="login-status ok">{toast}</p> : null}

      <section className="settings-card">
        <h2 className="row-title">{t('settings.language')}</h2>
        <p className="hint">{t('settings.languageHint')}</p>
        <div className="detail-actions">
          <button
            tabIndex={0}
            className={`cat-chip ${lang === 'es' ? 'selected' : ''}`}
            onClick={() => setLang('es')}
          >
            Español (ES)
          </button>
          <button
            tabIndex={0}
            className={`cat-chip ${lang === 'en' ? 'selected' : ''}`}
            onClick={() => setLang('en')}
          >
            English (EN)
          </button>
        </div>
      </section>

      <section className="settings-card">
        <h2 className="row-title">{t('settings.playback')}</h2>
        <p className="hint">{t('settings.seekHint')}</p>
        <div className="detail-actions">
          {[10, 30, 60].map((n) => (
            <button
              key={n}
              tabIndex={0}
              className={`cat-chip ${Number(prefs.seekJump) === n ? 'selected' : ''}`}
              onClick={() => patchPrefs({ seekJump: n })}
            >
              {n}s
            </button>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 14 }}>
          {t('settings.autoplayNext')}
        </p>
        <div className="detail-actions">
          <button
            tabIndex={0}
            className={`cat-chip ${prefs.autoplayNext ? 'selected' : ''}`}
            onClick={() => patchPrefs({ autoplayNext: true })}
          >
            {t('settings.autoplayOn')}
          </button>
          <button
            tabIndex={0}
            className={`cat-chip ${!prefs.autoplayNext ? 'selected' : ''}`}
            onClick={() => patchPrefs({ autoplayNext: false })}
          >
            {t('settings.autoplayOff')}
          </button>
        </div>
      </section>

      <section className="settings-card">
        <h2 className="row-title">{t('settings.uiScale')}</h2>
        <div className="detail-actions">
          {[
            ['comfortable', t('settings.uiComfortable')],
            ['normal', t('settings.uiNormal')],
            ['compact', t('settings.uiCompact')],
          ].map(([id, label]) => (
            <button
              key={id}
              tabIndex={0}
              className={`cat-chip ${prefs.uiScale === id ? 'selected' : ''}`}
              onClick={() => patchPrefs({ uiScale: id })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="detail-actions" style={{ marginTop: 12 }}>
          <button
            tabIndex={0}
            className="btn-ghost"
            onClick={() => {
              patchPrefs({ onboardingDone: false });
              // Force Home remount so tips overlay mounts and grabs TV focus.
              navigate('/', { replace: true, state: { showTips: true } });
            }}
          >
            {t('settings.showTips')}
          </button>
        </div>
      </section>

      <section className="settings-card">
        <h2 className="row-title">{t('settings.pin')}</h2>
        <p className="hint">{t('settings.pinHint')}</p>
        {profile?.pin ? (
          <input
            tabIndex={0}
            className="search-box pin-input"
            type="password"
            inputMode="numeric"
            placeholder={t('settings.currentPin')}
            value={currentPin}
            onChange={(e) => setCurrentPin(e.target.value)}
          />
        ) : (
          <p className="hint">{t('settings.noPin')}</p>
        )}
        <input
          tabIndex={0}
          className="search-box pin-input"
          type="password"
          inputMode="numeric"
          placeholder={t('parental.newPin')}
          value={newPin}
          onChange={(e) => setNewPin(e.target.value)}
        />
        <input
          tabIndex={0}
          className="search-box pin-input"
          type="password"
          inputMode="numeric"
          placeholder={t('parental.confirmPin')}
          value={confirmPin}
          onChange={(e) => setConfirmPin(e.target.value)}
        />
        <div className="detail-actions">
          <button tabIndex={0} className="btn-primary" onClick={savePin}>
            {t('parental.save')}
          </button>
        </div>
        {pinMsg.text && <p className={`login-status ${pinMsg.kind}`}>{pinMsg.text}</p>}
      </section>

      <section className="settings-card">
        <h2 className="row-title">{t('settings.support')}</h2>
        <p className="hint">{t('settings.supportHint')}</p>
      </section>
    </FocusScope>
  );
}
