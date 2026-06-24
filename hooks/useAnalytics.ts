import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/template';
import { fetchDashboardAnalytics, DashboardAnalytics } from '@/services/analyticsService';

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function useAnalytics() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);

  const refresh = useCallback(async (force = false) => {
    if (!user?.id) return;
    if (!force && lastFetched && Date.now() - lastFetched < CACHE_TTL) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDashboardAnalytics(user.id);
      setData(result);
      setLastFetched(Date.now());
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [user?.id, lastFetched]);

  useEffect(() => {
    refresh();
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, error, refresh: () => refresh(true), lastFetched };
}
