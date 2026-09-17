import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getActiveProfile, upsertProfile, verifyPin } from '../lib/parental.js';
import { useSession } from '../context/SessionContext.jsx';
import { FocusScope } from '../components/Focusable.jsx';

export default function Settings() {
  const navigate = useNavigate();
  const { lang, toggleLanguage } = useSession();

  // PIN change (reuses the parental profile registry).
  const profile = getActiveProfile();
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinMsg, setPinMsg] = useState({ text: '', kind: '' });

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
    </FocusScope>
  );
}
