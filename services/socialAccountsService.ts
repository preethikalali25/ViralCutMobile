import { getSupabaseClient } from '@/template';

export type Platform = 'tiktok' | 'reels' | 'youtube';

export interface SocialAccount {
  id: string;
  user_id: string;
  platform: Platform;
  handle: string;
  followers: number;
  connected_at: string;
  is_active: boolean;
}

export interface ConnectPayload {
  platform: Platform;
  handle: string;
  followers?: number;
}

export async function fetchSocialAccounts(): Promise<{ data: SocialAccount[]; error: string | null }> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('social_accounts')
    .select('*')
    .order('connected_at', { ascending: true });

  if (error) return { data: [], error: error.message };
  return { data: (data as SocialAccount[]) ?? [], error: null };
}

export async function connectSocialAccount(
  userId: string,
  payload: ConnectPayload
): Promise<{ data: SocialAccount | null; error: string | null }> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('social_accounts')
    .upsert(
      {
        user_id: userId,
        platform: payload.platform,
        handle: payload.handle,
        followers: payload.followers ?? 0,
        is_active: true,
        connected_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,platform' }
    )
    .select()
    .single();

  if (error) return { data: null, error: error.message };
  return { data: data as SocialAccount, error: null };
}

export async function disconnectSocialAccount(
  accountId: string
): Promise<{ error: string | null }> {
  const client = getSupabaseClient();
  const { error } = await client.from('social_accounts').delete().eq('id', accountId);
  if (error) return { error: error.message };
  return { error: null };
}
