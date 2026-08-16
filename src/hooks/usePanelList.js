import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { getSession } from '../lib/session.js';

// Loads a panel-backed list for the current session. Handles the loading /
// error states and a "reload" of categories selection.
export function usePanelList(loadFn, args = []) {
  const { session } = useSession();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const server = useMemo(() => {
    const saved = getSession();
    return (
      session?.session || {
        baseUrl: saved?.baseUrl,
        username: saved?.username,
        password: saved?.password,
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const reload = useCallback(() => setTick((x) => x + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (!server || !server.baseUrl) {
      setError('no-session');
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    setError(null);
    loadFn(server, ...args)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, tick, JSON.stringify(args)]);

  return { data, error, loading, reload, server };
}
