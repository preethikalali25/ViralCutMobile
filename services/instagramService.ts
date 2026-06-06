import { getSupabaseClient } from '@/template';
import { FunctionsHttpError } from '@supabase/supabase-js';

export interface InstagramStatus {
  connected: boolean;
  expired?: boolean;
  username?: string;
  profilePictureUrl?: string;
  followersCount?: number;
  igUserId?: string;
}

export interface InstagramProfile {
  username?: string;
  bio?: string;
  followersCount?: number;
  mediaCount?: number;
  recentPosts?: Array<{
    type: string;
    caption?: string;
    likes?: number;
    comments?: number;
    date: string;
  }>;
}

async function invoke(action: string, payload: Record<string, unknown>) {
  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke('instagram-publisher', {
    body: { action, ...payload },
  });
  if (error) {
    let msg = error.message;
    if (error instanceof FunctionsHttpError) {
      try { msg = await error.context?.text() ?? msg; } catch { /* ignore */ }
    }
    return { data: null, error: msg };
  }
  return { data, error: null };
}

export async function getInstagramAuthUrl(
  redirectUri: string,
): Promise<{ authUrl: string; state: string } | { error: string }> {
  const { data, error } = await invoke('oauth_url', { redirectUri });
  if (error) return { error };
  return { authUrl: data.authUrl, state: data.state };
}

export async function exchangeInstagramCode(
  code: string,
  redirectUri: string,
  userId: string,
): Promise<{ username: string; followersCount: number } | { error: string }> {
  const { data, error } = await invoke('exchange_token', { code, redirectUri, userId });
  if (error) return { error };
  return { username: data.username, followersCount: data.followersCount };
}

export async function getInstagramProfile(userId: string): Promise<InstagramProfile | null> {
  const { data, error } = await invoke('get_profile', { userId });
  if (error || !data) return null;
  return data as InstagramProfile;
}

export async function getInstagramStatus(userId: string): Promise<InstagramStatus> {
  const { data, error } = await invoke('get_status', { userId });
  if (error || !data) return { connected: false };
  return data as InstagramStatus;
}

export async function disconnectInstagram(userId: string): Promise<{ error?: string }> {
  const { error } = await invoke('disconnect', { userId });
  return { error: error ?? undefined };
}

export async function createInstagramContainer(
  userId: string,
  videoUrl: string,
  caption: string,
  coverUrl?: string,
  audioName?: string,
): Promise<{ containerId?: string; error?: string }> {
  const { data, error } = await invoke('publish', { userId, videoUrl, caption, coverUrl, audioName });
  if (error) return { error };
  return { containerId: data.containerId };
}

export async function getContainerStatus(
  userId: string,
  containerId: string,
): Promise<{ statusCode?: string; error?: string }> {
  const { data, error } = await invoke('container_status', { userId, containerId });
  if (error) return { error };
  return { statusCode: data.statusCode };
}

export async function publishInstagramContainer(
  userId: string,
  containerId: string,
): Promise<{ mediaId?: string; error?: string }> {
  const { data, error } = await invoke('media_publish', { userId, containerId });
  if (error) return { error };
  return { mediaId: data.mediaId };
}
