import { getSupabaseClient } from '@/template';
import { FunctionsHttpError } from '@supabase/supabase-js';
import * as ExpoCrypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';

export const YOUTUBE_CLIENT_ID =
  '384305956807-kv2rnvrc34olbbap2j0k6ilo1i445tpi.apps.googleusercontent.com';

export const YOUTUBE_REDIRECT_URI =
  'com.googleusercontent.apps.384305956807-kv2rnvrc34olbbap2j0k6ilo1i445tpi:/oauth2redirect';

export interface YouTubeStatus {
  connected: boolean;
  expired?: boolean;
  channelId?: string;
  channelTitle?: string;
  channelThumbnail?: string;
}

export function generateCodeVerifier(): string {
  const bytes = ExpoCrypto.getRandomBytes(64);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 128);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await ExpoCrypto.digest(
    ExpoCrypto.CryptoDigestAlgorithm.SHA256,
    data,
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest as ArrayBuffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function buildGoogleAuthUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: YOUTUBE_CLIENT_ID,
    redirect_uri: YOUTUBE_REDIRECT_URI,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
    ].join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function invoke(action: string, payload: Record<string, unknown>) {
  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke('youtube-publisher', {
    body: { action, ...payload },
  });
  if (error) {
    let msg = error.message;
    if (error instanceof FunctionsHttpError) {
      try { msg = (await error.context?.text()) ?? msg; } catch { /* ignore */ }
    }
    return { data: null, error: msg };
  }
  return { data, error: null };
}

export async function exchangeYouTubeCode(
  code: string,
  codeVerifier: string,
  userId: string,
): Promise<{ channelTitle: string; channelId: string } | { error: string }> {
  const { data, error } = await invoke('exchange_token', { code, codeVerifier, userId });
  if (error) return { error };
  return { channelTitle: data.channelTitle ?? '', channelId: data.channelId ?? '' };
}

export async function getYouTubeStatus(userId: string): Promise<YouTubeStatus> {
  const { data, error } = await invoke('get_status', { userId });
  if (error || !data) return { connected: false };
  return data as YouTubeStatus;
}

export async function disconnectYouTube(userId: string): Promise<{ error?: string }> {
  const { error } = await invoke('disconnect', { userId });
  return { error: error ?? undefined };
}

export async function initYouTubeUpload(
  userId: string,
  title: string,
  videoSize: number,
  description?: string,
  privacyStatus = 'public',
): Promise<{ uploadUrl: string } | { error: string }> {
  const { data, error } = await invoke('init_upload', {
    userId, title, videoSize, description, privacyStatus,
  });
  if (error) return { error };
  if (!data?.uploadUrl) return { error: 'No upload URL returned from YouTube' };
  return { uploadUrl: data.uploadUrl };
}

export async function uploadVideoToYouTube(
  localUri: string,
  uploadUrl: string,
  videoSize: number,
  onProgress?: (pct: number) => void,
): Promise<{ error?: string }> {
  try {
    onProgress?.(5);
    const result = await FileSystem.uploadAsync(uploadUrl, localUri, {
      httpMethod: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(videoSize),
      },
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    });
    onProgress?.(100);

    if (result.status !== 200 && result.status !== 201) {
      return { error: `YouTube upload failed: HTTP ${result.status}` };
    }
    return {};
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}
