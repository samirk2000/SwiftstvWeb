import { BrowserRouter, Navigate, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useState, useCallback } from 'react';
import { SessionProvider, useSession } from './context/SessionContext.jsx';
import {
  FocusRoot,
  FocusScope,
  useGlobalTvKeys,
  useAutoFocus,
  useFocusable,
  openIme,
  resolveEditable,
  setFocused,
} from './components/Focusable.jsx';
import { getSession } from './lib/session.js';
import { t } from './lib/i18n.js';
import Login from './screens/Login.jsx';
import Home from './screens/Home.jsx';
import LiveGuide from './screens/LiveGuide.jsx';
import VodGrid from './screens/VodGrid.jsx';
import VodDetail from './screens/VodDetail.jsx';
import SeriesList from './screens/SeriesList.jsx';
import SeriesDetail from './screens/SeriesDetail.jsx';
import Player from './screens/Player.jsx';
import Exclusivos from './screens/Exclusivos.jsx';
import Parental from './screens/Parental.jsx';
import Accounts from './screens/Accounts.jsx';
import Settings from './screens/Settings.jsx';
import GlobalSearch from './screens/GlobalSearch.jsx';
import { applyUiScale } from './lib/prefs.js';

function TopBar() {
  const { logout, toggleLanguage, lang, session } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const isPlayer = location.pathname === '/player';
  const isLogin = location.pathname === '/login';
  const loggedIn = Boolean(session || getSession());
  const brand = useFocusable('top-brand');
  const langBtn = useFocusable('top-lang');
  const logoutBtn = useFocusable('top-logout');

  if (isPlayer) return null;

  return (
    <header className="topbar">
      <div
        ref={brand.ref}
        tabIndex={brand.tabIndex}
        role="button"
        className="brand"
        onClick={() => navigate(loggedIn && !isLogin ? '/' : location.pathname)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && loggedIn && !isLogin) navigate('/');
        }}
      >
        Swift<em>tv</em>
      </div>
      <div className="topbar-actions">
        <button
          ref={langBtn.ref}
          tabIndex={langBtn.tabIndex}
          className="lang-toggle"
          onClick={toggleLanguage}
        >
          {lang === 'es' ? 'ES' : 'EN'}
        </button>
        {!isLogin && loggedIn ? (
          <button
            ref={logoutBtn.ref}
            tabIndex={logoutBtn.tabIndex}
            className="btn-ghost"
            onClick={() => {
              logout();
              navigate('/login');
            }}
          >
            {lang === 'es' ? 'Cerrar sesión' : 'Sign out'}
          </button>
        ) : null}
      </div>
    </header>
  );
}

function RequireSession({ children }) {
  const { session } = useSession();
  const saved = getSession();
  if (!session && !saved) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function exitApp() {
  try {
    if (window.webOS && typeof window.webOS.platformBack === 'function') {
      window.webOS.platformBack();
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    if (window.PalmSystem && typeof window.PalmSystem.platformBack === 'function') {
      window.PalmSystem.platformBack();
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    window.close();
  } catch {
    /* ignore */
  }
}

/** Root-level confirm before leaving the app (accidental Back on Home/Login). */
function ExitConfirm({ open, onCancel, onConfirm }) {
  const cancelRef = useFocusable('exit-cancel');
  const confirmRef = useFocusable('exit-confirm');

  useEffect(() => {
    if (!open) return undefined;
    const t = window.setTimeout(() => {
      // Default to "No" so a double-Back doesn't instantly quit.
      setFocused(cancelRef.ref.current, { native: false });
    }, 40);
    return () => window.clearTimeout(t);
  }, [open, cancelRef.ref]);

  if (!open) return null;

  return (
    <div className="exit-overlay" role="dialog" aria-modal="true" aria-labelledby="exit-title">
      <FocusScope trap autoFocus className="exit-dialog">
        <h2 id="exit-title">{t('exit.title')}</h2>
        <p>{t('exit.message')}</p>
        <div className="exit-actions">
          <button
            ref={cancelRef.ref}
            tabIndex={0}
            className="btn-primary"
            data-focusable="true"
            onClick={onCancel}
          >
            {t('exit.cancel')}
          </button>
          <button
            ref={confirmRef.ref}
            tabIndex={0}
            className="btn-ghost"
            data-focusable="true"
            onClick={onConfirm}
          >
            {t('exit.confirm')}
          </button>
        </div>
      </FocusScope>
    </div>
  );
}

function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [exitOpen, setExitOpen] = useState(false);

  useEffect(() => {
    applyUiScale();
  }, []);

  const isRootRoute =
    location.pathname === '/' ||
    location.pathname === '/login' ||
    location.pathname === '';

  const closeExit = useCallback(() => {
    setExitOpen(false);
  }, []);

  // Reclaim / move focus whenever the route changes (Settings, Live, modals-as-pages…).
  useAutoFocus([location.pathname, location.search, exitOpen], '.app-shell');

  useGlobalTvKeys({
    onEscape: () => {
      if (exitOpen) {
        closeExit();
        return;
      }
      // Player owns its Back (leave confirm for VOD/series).
      if (location.pathname === '/player') return;
      // Accidental Back on Home/Login → ask before quitting the app.
      if (isRootRoute) {
        setExitOpen(true);
        return;
      }
      navigate(-1);
    },
    onEnter: () => {
      const el =
        document.querySelector('[data-tv-focused="true"]') ||
        document.querySelector('.tv-focused') ||
        document.activeElement;
      if (!el) return;
      const editable = resolveEditable(el);
      if (editable) {
        openIme(editable);
        return;
      }
      if (typeof el.click === 'function') el.click();
    },
  });

  return (
    <div className="app-shell">
      <TopBar />
      <main className="content">
        <FocusScope key={location.pathname} trap={false} autoFocus className="screen-scope">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/"
              element={
                <RequireSession>
                  <Home />
                </RequireSession>
              }
            />
            <Route
              path="/live"
              element={
                <RequireSession>
                  <LiveGuide />
                </RequireSession>
              }
            />
            <Route
              path="/vod"
              element={
                <RequireSession>
                  <VodGrid />
                </RequireSession>
              }
            />
            <Route
              path="/vod/:id"
              element={
                <RequireSession>
                  <VodDetail />
                </RequireSession>
              }
            />
            <Route
              path="/series"
              element={
                <RequireSession>
                  <SeriesList />
                </RequireSession>
              }
            />
            <Route
              path="/series/:id"
              element={
                <RequireSession>
                  <SeriesDetail />
                </RequireSession>
              }
            />
            <Route
              path="/player"
              element={
                <RequireSession>
                  <Player />
                </RequireSession>
              }
            />
            <Route
              path="/search"
              element={
                <RequireSession>
                  <GlobalSearch />
                </RequireSession>
              }
            />
            <Route
              path="/exclusivos"
              element={
                <RequireSession>
                  <Exclusivos />
                </RequireSession>
              }
            />
            <Route
              path="/parental"
              element={
                <RequireSession>
                  <Parental />
                </RequireSession>
              }
            />
            <Route
              path="/accounts"
              element={
                <RequireSession>
                  <Accounts />
                </RequireSession>
              }
            />
            <Route
              path="/settings"
              element={
                <RequireSession>
                  <Settings />
                </RequireSession>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </FocusScope>
      </main>

      <ExitConfirm open={exitOpen} onCancel={closeExit} onConfirm={exitApp} />
    </div>
  );
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <FocusRoot>
          <ScrollToTop />
          <AppShell />
        </FocusRoot>
      </SessionProvider>
    </BrowserRouter>
  );
}
