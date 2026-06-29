import { useEffect, useState } from 'react';
import { AuthRouter, useAuth } from '@/template';
import { Redirect } from 'expo-router';
import { getSupabaseClient } from '@/template';

async function hasAnySocialConnected(userId: string): Promise<boolean> {
  const supabase = getSupabaseClient();
  const [ig, tt, yt] = await Promise.all([
    supabase.from('instagram_tokens').select('id').eq('user_id', userId).maybeSingle(),
    supabase.from('tiktok_tokens').select('id').eq('user_id', userId).maybeSingle(),
    supabase.from('youtube_tokens').select('id').eq('user_id', userId).maybeSingle(),
  ]);
  return !!(ig.data || tt.data || yt.data);
}

function AuthenticatedRoot() {
  const { user } = useAuth();
  const [checked, setChecked] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    hasAnySocialConnected(user.id).then(connected => {
      setNeedsOnboarding(!connected);
      setChecked(true);
    });
  }, [user?.id]);

  if (!checked) return null;
  if (needsOnboarding) return <Redirect href="/onboarding" />;
  return <Redirect href="/(tabs)" />;
}

export default function RootScreen() {
  return (
    <AuthRouter loginRoute="/login">
      <AuthenticatedRoot />
    </AuthRouter>
  );
}
