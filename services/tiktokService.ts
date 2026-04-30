import { getSupabaseClient } from '@/template';
import { FunctionsHttpError } from '@supabase/supabase-js';

export interface TikTokStatus {
  connected: boolean;
  expired?: boolean;
  creatorName?: string;
  creatorAvatar?: string;
  openId?: string;
}

export interface TikTokPublishResult {
  publishId?: string;
  error?: string;
}

/** Generate a random PKCE code verifier (43-128 chars, URL-safe) */
export function generateCodeVerifier(): string {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 128);
}

/** Invoke the tiktok-publisher Edge Function */
async function invoke(action: string, payload: Record<string, unknown>) {
  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke('tiktok-publisher', {
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

/** Get TikTok OAuth authorization URL */
export async function getTikTokAuthUrl(
  redirectUri: string,
  codeVerifier: string,
): Promise<{ authUrl: string; state: string } | { error: string }> {
  const { data, error } = await invoke('oauth_url', { redirectUri, codeVerifier });
  if (error) return { error };
  return { authUrl: data.authUrl, state: data.state };
}

/** Exchange authorization code for tokens and store in DB */
export async function exchangeTikTokCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  userId: string,
): Promise<{ creatorName: string; error?: undefined } | { error: string }> {
  const { data, error } = await invoke('exchange_token', { code, redirectUri, codeVerifier, userId });
  if (error) return { error };
  return { creatorName: data.creatorName };
}

/** Check whether the current user has a valid TikTok connection */
export async function getTikTokStatus(userId: string): Promise<TikTokStatus> {
  const { data, error } = await invoke('get_status', { userId });
  if (error || !data) return { connected: false };
  return data as TikTokStatus;
}

/** Disconnect TikTok by deleting stored tokens */
export async function disconnectTikTok(userId: string): Promise<{ error?: string }> {
  const { error } = await invoke('disconnect', { userId });
  return { error: error ?? undefined };
}

/**
 * Publish a video to TikTok.
 * videoUrl must be a publicly accessible URL (not a local file:// URI).
 * privacyLevel: 'SELF_ONLY' | 'FRIENDS_ONLY' | 'MUTUAL_FOLLOW_FRIENDS' | 'PUBLIC_TO_EVERYONE'
 */
export async function publishToTikTok(
  userId: string,
  videoUrl: string,
  title: string,
  privacyLevel: string = 'SELF_ONLY',
): Promise<TikTokPublishResult> {
  const { data, error } = await invoke('publish', { userId, videoUrl, title, privacyLevel });
  if (error) return { error };
  return { publishId: data.publishId };
}

/** Poll publish status by publish_id */
export async function getTikTokPublishStatus(
  userId: string,
  publishId: string,
): Promise<{ status?: string; error?: string }> {
  const { data, error } = await invoke('publish_status', { userId, publishId });
  if (error) return { error };
  const publishStatus = data?.result?.data?.status ?? data?.result?.data?.publish_status ?? 'UNKNOWN';
  return { status: publishStatus };
}
