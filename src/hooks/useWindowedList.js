import { useEffect, useMemo, useState } from 'react';

/**
 * Cap how many DOM nodes we paint at once on TV browsers.
 * Full array stays in memory for search / CH± zap; only `visible` mounts.
 */
export function useWindowedList(items, pageSize = 48) {
  const [limit, setLimit] = useState(pageSize);

  useEffect(() => {
    setLimit(pageSize);
  }, [items, pageSize]);

  const list = Array.isArray(items) ? items : [];
  const visible = useMemo(() => list.slice(0, limit), [list, limit]);
  const hasMore = list.length > limit;
  const remaining = Math.max(0, list.length - limit);

  const loadMore = () => setLimit((n) => n + pageSize);

  return { visible, hasMore, loadMore, remaining, total: list.length };
}
