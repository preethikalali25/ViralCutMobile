import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/template';
import { getScheduledPosts, ScheduledPost } from '@/services/scheduleService';

export function useScheduledPosts() {
  const { user } = useAuth();
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    const { posts: fetched } = await getScheduledPosts(user.id);
    setPosts(fetched);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { refresh(); }, [refresh]);

  return { posts, loading, refresh };
}
