import { getSupabaseClient } from '@/template';
import { FunctionsHttpError } from '@supabase/supabase-js';
import * as ExpoCrypto from 'expo-crypto';

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
  const bytes = ExpoCrypto.getRandomBytes(64);
  return btoa(String.fromCharCode(...bytes))
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

/** Manually refresh the TikTok access token using the stored refresh token */
export async function refreshTikTokToken(userId: string): Promise<{ error?: string }> {
  const { error } = await invoke('refresh_token', { userId });
  return { error: error ?? undefined };
}

/**
 * Initialize a FILE_UPLOAD publish on TikTok.
 * Returns publishId and uploadUrl — then upload the binary to uploadUrl directly.
 */
export async function initTikTokPublish(
  userId: string,
  videoSize: number,
  title: string,
  privacyLevel: string = 'SELF_ONLY',
): Promise<{ publishId?: string; uploadUrl?: string; error?: string }> {
  const chunkSize = videoSize; // single chunk
  const { data, error } = await invoke('publish', {
    userId, title, privacyLevel,
    videoSize, chunkSize, totalChunkCount: 1,
    videoUrl: '', // not used for FILE_UPLOAD but kept for compat
  });
  if (error) return { error };
  return { publishId: data.publishId, uploadUrl: data.uploadUrl };
}

/**
 * Upload a local video file directly to TikTok's upload URL (FILE_UPLOAD flow).
 */
export async function uploadVideoToTikTok(
  localUri: string,
  uploadUrl: string,
  videoSize: number,
  onProgress?: (pct: number) => void,
): Promise<{ error?: string }> {
  try {
    const FileSystem = await import('expo-file-system');
    onProgress?.(10);
    const result = await FileSystem.uploadAsync(uploadUrl, localUri, {
      httpMethod: 'PUT',
      uploadType: (FileSystem as any).FileSystemUploadType.BINARY_CONTENT,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
        'Content-Length': String(videoSize),
      },
    });
    onProgress?.(100);
    if (result.status < 200 || result.status > 299) {
      return { error: `TikTok upload failed with status ${result.status}` };
    }
    return {};
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

/**
 * Upload a local video file to Supabase Storage and return its public URL.
 * On mobile, file:// URIs must be read as base64 since fetch() can't access them.
 */
export async function uploadVideoToStorage(
  localUri: string,
  userId: string,
  videoId: string,
  onProgress?: (pct: number) => void,
): Promise<{ publicUrl?: string; error?: string }> {
  try {
    const client = getSupabaseClient();
    const fileName = `${userId}/${videoId}.mp4`;

    // React Native: read as base64, convert to ArrayBuffer
    const FileSystem = await import('expo-file-system');
    const base64 = await FileSystem.readAsStringAsync(localUri, {
      encoding: FileSystem.EncodingType.Base64,
    });

    // Decode base64 → Uint8Array
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    onProgress?.(30);

    const { error } = await client.storage
      .from('videos')
      .upload(fileName, bytes.buffer as ArrayBuffer, {
        contentType: 'video/mp4',
        upsert: true,
      });

    if (error) return { error: error.message };
    onProgress?.(100);

    const { data } = client.storage.from('videos').getPublicUrl(fileName);
    return { publicUrl: data.publicUrl };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
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
