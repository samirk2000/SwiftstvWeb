import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  clearSession as clearStored,
  getLanguage,
  saveLanguage,
  getSession,
  saveSession,
  ensureActiveAccountListed,
  upsertAccount,
} from '../lib/session.js';
import { setLang as setI18nLang, getLang } from '../lib/i18n.js';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [session, setSession] = useState(null);
  const [accountsTick, setAccountsTick] = useState(0);

  useEffect(() => {
    const lang = getLanguage();
    setI18nLang(lang);
    ensureActiveAccountListed();
  }, []);

  const bumpAccounts = useCallback(() => setAccountsTick((x) => x + 1), []);

  const loginSuccess = useCallback(
    (s) => {
      setSession(s);
      // dns/xtream already saveSession (which upserts); re-upsert for safety.
      const creds = s?.session || s;
      if (creds?.baseUrl && creds?.username && creds?.password) {
        upsertAccount({
          baseUrl: creds.baseUrl || s.workingBaseUrl,
          username: creds.username,
          password: creds.password,
          user_info: s.info || creds.user_info || null,
        });
        bumpAccounts();
      }
    },
    [bumpAccounts]
  );

  const logout = useCallback(() => {
    clearStored();
    setSession(null);
  }, []);

  // Manual server override (Settings): swap the session baseUrl in both the
  // stored session and the live context so usePanelList / stream URLs rebuild
  // against the new host without a re-login.
  const updateServer = useCallback(
    (baseUrl) => {
      const saved = getSession();
      if (!saved) return;
      const next = { ...saved, baseUrl };
      saveSession(next);
      bumpAccounts();
      setSession((prev) => {
        if (!prev) return prev;
        const s = prev.session
          ? { ...prev.session, baseUrl }
          : { baseUrl, username: saved.username, password: saved.password };
        return { ...prev, session: s, workingBaseUrl: baseUrl };
      });
    },
    [bumpAccounts]
  );

  const [langTick, setLangTick] = useState(0);

  const toggleLanguage = useCallback(() => {
    const next = getLang() === 'es' ? 'en' : 'es';
    setI18nLang(next);
    saveLanguage(next);
    setLangTick((x) => x + 1);
  }, []);

  const value = useMemo(
    () => ({
      session,
      loginSuccess,
      logout,
      updateServer,
      toggleLanguage,
      lang: getLang(),
      langTick,
      accountsTick,
      bumpAccounts,
    }),
    [session, loginSuccess, logout, updateServer, toggleLanguage, langTick, accountsTick, bumpAccounts]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
