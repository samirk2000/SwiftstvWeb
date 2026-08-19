import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getSession } from '../lib/session.js';
import { getActiveProfile, upsertProfile, verifyPin } from '../lib/parental.js';
import { useSession } from '../context/SessionContext.jsx';

function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  while (u.length > 0 && u.endsWith('/')) u = u.slice(0, -1);
  return u;
}

export default function Settings() {
  const navigate = useNavigate();
  const { lang, toggleLanguage, updateServer } = useSession();

  const [serverUrl, setServerUrl] = useState(() => normalizeUrl(getSession()?.baseUrl || ''));
  const [serverMsg, setServerMsg] = useState({ text: '', kind: '' });

  // PIN change (reuses the parental profile registry).
  const profile = getActiveProfile();
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinMsg, setPinMsg] = useState({ text: '', kind: '' });

  const saveServer = () => {
    const url = normalizeUrl(serverUrl);
    if (!/^https?:\/\//i.test(url)) {
      setServerMsg({ text: t('settings.serverInvalid'), kind: 'err' });
      return;
    }
    updateServer(url);
    setServerMsg({ text: t('settings.saved'), kind: 'ok' });
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
    <div>
      <div className="page-head">
        <button className="back-btn" onClick={() => navigate(-1)}>
          ← {t('common.back')}
        </button>
        <h1>{t('settings.title')}</h1>
      </div>

      <section className="settings-card">
        <h2 className="row-title">{t('settings.language')}</h2>
        <p className="hint">{t('settings.languageHint')}</p>
        <div className="detail-actions">
          <button
            className={`cat-chip ${lang === 'es' ? 'selected' : ''}`}
            onClick={() => setLang('es')}
          >
            Español (ES)
          </button>
          <button
            className={`cat-chip ${lang === 'en' ? 'selected' : ''}`}
            onClick={() => setLang('en')}
          >
            English (EN)
          </button>
        </div>
      </section>

      <section className="settings-card">
        <h2 className="row-title">{t('settings.server')}</h2>
        <p className="hint">{t('settings.serverHint')}</p>
        <input
          className="search-box"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="http://host:8080"
        />
        <div className="detail-actions">
          <button className="btn-primary" onClick={saveServer}>
            {t('settings.serverSave')}
          </button>
        </div>
        {serverMsg.text && <p className={`login-status ${serverMsg.kind}`}>{serverMsg.text}</p>}
      </section>

      <section className="settings-card">
        <h2 className="row-title">{t('settings.pin')}</h2>
        <p className="hint">{t('settings.pinHint')}</p>
        {profile?.pin ? (
          <input
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
          className="search-box pin-input"
          type="password"
          inputMode="numeric"
          placeholder={t('parental.newPin')}
          value={newPin}
          onChange={(e) => setNewPin(e.target.value)}
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
        </div>
        {pinMsg.text && <p className={`login-status ${pinMsg.kind}`}>{pinMsg.text}</p>}
      </section>
    </div>
  );
}
