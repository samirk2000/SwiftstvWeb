import { BrowserRouter, Navigate, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { SessionProvider, useSession } from './context/SessionContext.jsx';
import { FocusRoot, useGlobalTvKeys } from './components/Focusable.jsx';
import { getSession } from './lib/session.js';
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

function TopBar() {
  const { logout, toggleLanguage, lang } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const isPlayer = location.pathname === '/player';
  if (isPlayer) return null;

  return (
    <header className="topbar">
      <div className="brand" onClick={() => navigate('/')}>
        Swift<em>tv</em>
      </div>
      <div className="topbar-actions">
        <button className="lang-toggle" onClick={toggleLanguage}>
          {lang === 'es' ? 'ES' : 'EN'}
        </button>
        <button
          className="btn-ghost"
          onClick={() => {
            logout();
            navigate('/login');
          }}
        >
          {lang === 'es' ? 'Cerrar sesión' : 'Sign out'}
        </button>
      </div>
    </header>
  );
}

// Only allow access to inner screens with an active/live-saved session.
function RequireSession({ children }) {
  const { session } = useSession();
  const saved = getSession();
  if (!session && !saved) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function AppShell() {
  const navigate = useNavigate();

  // Global TV keys. Escape/Back pops history; Enter activates focus.
  useGlobalTvKeys({
    onEscape: () => {
      if (window.location.pathname !== '/login') navigate(-1);
    },
    onEnter: () => {
      const el = document.activeElement;
      if (el && typeof el.click === 'function') el.click();
    },
  });

  return (
    <div className="app-shell">
      <TopBar />
      <main className="content">
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
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
