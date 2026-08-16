import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { clearSession as clearStored, getLanguage, saveLanguage } from '../lib/session.js';
import { setLang as setI18nLang, getLang } from '../lib/i18n.js';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [session, setSession] = useState(null);

  useEffect(() => {
    const lang = getLanguage();
    setI18nLang(lang);
  }, []);

  const loginSuccess = useCallback((s) => {
    setSession(s);
  }, []);

  const logout = useCallback(() => {
    clearStored();
    setSession(null);
  }, []);

  const [langTick, setLangTick] = useState(0);

  const toggleLanguage = useCallback(() => {
    const next = getLang() === 'es' ? 'en' : 'es';
    setI18nLang(next);
    saveLanguage(next);
    setLangTick((x) => x + 1);
  }, []);

  const value = useMemo(
    () => ({ session, loginSuccess, logout, toggleLanguage, lang: getLang(), langTick }),
    [session, loginSuccess, logout, toggleLanguage, langTick]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
