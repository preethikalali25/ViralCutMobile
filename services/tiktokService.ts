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

const TIKTOK_MAX_CHUNK = 64 * 1024 * 1024; // TikTok hard limit: 64 MB per chunk

/**
 * Initialize a FILE_UPLOAD publish on TikTok.
 * Automatically splits videos >64 MB into multiple chunks.
 * Returns publishId and uploadUrl — then upload binary chunks to uploadUrl.
 */
export async function initTikTokPublish(
  userId: string,
  videoSize: number,
  title: string,
  privacyLevel: string = 'SELF_ONLY',
): Promise<{ publishId?: string; uploadUrl?: string; error?: string }> {
  const chunkSize = Math.min(videoSize, TIKTOK_MAX_CHUNK);
  const totalChunkCount = Math.ceil(videoSize / chunkSize);
  const { data, error } = await invoke('publish', {
    userId, title, privacyLevel,
    videoSize, chunkSize, totalChunkCount,
    videoUrl: '',
  });
  if (error) return { error };
  return { publishId: data.publishId, uploadUrl: data.uploadUrl };
}

/**
 * Upload a local video file directly to TikTok's upload URL (FILE_UPLOAD flow).
 * Handles multi-chunk uploads for videos larger than 64 MB.
 */
export async function uploadVideoToTikTok(
  localUri: string,
  uploadUrl: string,
  videoSize: number,
  onProgress?: (pct: number) => void,
): Promise<{ error?: string }> {
  const chunkSize = Math.min(videoSize, TIKTOK_MAX_CHUNK);
  const totalChunks = Math.ceil(videoSize / chunkSize);

  try {
    const FileSystem = await import('expo-file-system');

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, videoSize) - 1;
      const thisChunkSize = end - start + 1;

      onProgress?.(10 + Math.round((i / totalChunks) * 85));

      let chunkUri = localUri;
      let isTempFile = false;

      if (totalChunks > 1) {
        // Read this slice as base64 and write to a temp file so uploadAsync
        // can stream it without holding the full video in memory.
        const b64 = await (FileSystem as any).readAsStringAsync(localUri, {
          encoding: (FileSystem as any).EncodingType.Base64,
          position: start,
          length: thisChunkSize,
        });
        const tempUri = `${(FileSystem as any).cacheDirectory}tiktok_c${i}_${Date.now()}.mp4`;
        await (FileSystem as any).writeAsStringAsync(tempUri, b64, {
          encoding: (FileSystem as any).EncodingType.Base64,
        });
        chunkUri = tempUri;
        isTempFile = true;
      }

      const result = await (FileSystem as any).uploadAsync(uploadUrl, chunkUri, {
        httpMethod: 'PUT',
        uploadType: (FileSystem as any).FileSystemUploadType.BINARY_CONTENT,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${videoSize}`,
          'Content-Length': String(thisChunkSize),
        },
      });

      if (isTempFile) {
        (FileSystem as any).deleteAsync(chunkUri, { idempotent: true }).catch(() => {});
      }

      if (result.status < 200 || result.status > 299) {
        return { error: `TikTok upload failed (chunk ${i + 1}/${totalChunks}) with status ${result.status}` };
      }
    }

    onProgress?.(100);
    return {};
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

/**
 * Upload a local video file to Supabase Storage and return its public URL.
 * Uses FileSystem.uploadAsync for memory-efficient binary upload on mobile.
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
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;

    // Get the authenticated user's JWT for the upload request
    const { data: { session } } = await client.auth.getSession();
    const token = session?.access_token ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

    onProgress?.(10);

    const FileSystem = await import('expo-file-system');
    const uploadUrl = `${supabaseUrl}/storage/v1/object/videos/${fileName}`;

    const result = await (FileSystem as any).uploadAsync(uploadUrl, localUri, {
      httpMethod: 'POST',
      uploadType: (FileSystem as any).FileSystemUploadType.BINARY_CONTENT,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'video/mp4',
        'x-upsert': 'true',
      },
    });

    if (result.status < 200 || result.status > 299) {
      return { error: `Storage upload failed (${result.status}): ${result.body ?? ''}` };
    }

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
