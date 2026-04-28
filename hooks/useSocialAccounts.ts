import { useState, useCallback } from 'react';
import {
  fetchSocialAccounts,
  connectSocialAccount,
  disconnectSocialAccount,
  SocialAccount,
  Platform,
} from '@/services/socialAccountsService';

export function useSocialAccounts() {
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await fetchSocialAccounts();
    setAccounts(data);
    setError(err);
    setLoading(false);
  }, []);

  const connect = useCallback(
    async (userId: string, platform: Platform, handle: string, followers?: number) => {
      const { data, error: err } = await connectSocialAccount(userId, { platform, handle, followers });
      if (err) return { error: err };
      if (data) {
        setAccounts(prev => {
          const idx = prev.findIndex(a => a.platform === platform);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = data;
            return next;
          }
          return [...prev, data];
        });
      }
      return { error: null };
    },
    []
  );

  const disconnect = useCallback(async (accountId: string) => {
    const { error: err } = await disconnectSocialAccount(accountId);
    if (err) return { error: err };
    setAccounts(prev => prev.filter(a => a.id !== accountId));
    return { error: null };
  }, []);

  const getAccount = (platform: Platform) => accounts.find(a => a.platform === platform) ?? null;

  return { accounts, loading, error, load, connect, disconnect, getAccount };
}
