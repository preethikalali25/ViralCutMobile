import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/template';
import {
  TikTokStatus,
  getTikTokStatus,
  disconnectTikTok,
  publishToTikTok,
  getTikTokPublishStatus,
  getTikTokAuthUrl,
  exchangeTikTokCode,
  generateCodeVerifier,
} from '@/services/tiktokService';
import * as WebBrowser from 'expo-web-browser';
import { Linking } from 'react-native';

// The redirect URI registered in TikTok Developer portal.
// TikTok redirects here → backend forwards to viralcut://tiktok-callback.
// Register exactly this URL in TikTok Developer Portal → your app → Redirect URI.
export const TIKTOK_REDIRECT_URI = 'https://mrsvovoywukechawmrsv.backend.onspace.ai/functions/v1/tiktok-publisher?action=callback';

export type PublishPhase =
  | 'idle'
  | 'uploading'
  | 'processing'
  | 'success'
  | 'error';

export interface PublishState {
  phase: PublishPhase;
  publishId?: string;
  errorMessage?: string;
}

export function useTikTok() {
  const { user } = useAuth();
  const [status, setStatus] = useState<TikTokStatus>({ connected: false });
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [connectingOAuth, setConnectingOAuth] = useState(false);
  const [publishState, setPublishState] = useState<PublishState>({ phase: 'idle' });
  const codeVerifierRef = useRef<string>('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    if (!user?.id) return;
    setLoadingStatus(true);
    const s = await getTikTokStatus(user.id);
    setStatus(s);
    setLoadingStatus(false);
  }, [user?.id]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // ── OAuth Connect Flow ────────────────────────────────────────────────────
  const connect = useCallback((): Promise<{ error?: string }> => {
    return new Promise(async (resolve) => {
      if (!user?.id) return resolve({ error: 'Not logged in' });

      setConnectingOAuth(true);

      let subscription: ReturnType<typeof Linking.addEventListener> | null = null;

      const cleanup = () => {
        subscription?.remove();
        WebBrowser.dismissBrowser();
      };

      try {
        // Generate PKCE
        const codeVerifier = generateCodeVerifier();
        codeVerifierRef.current = codeVerifier;

        // Get auth URL from Edge Function
        const result = await getTikTokAuthUrl(TIKTOK_REDIRECT_URI, codeVerifier);
        if ('error' in result) {
          setConnectingOAuth(false);
          return resolve({ error: result.error });
        }

        // Listen for the deep-link BEFORE opening the browser
        // iOS/Android will fire Linking event when viralcut://tiktok-callback is hit
        subscription = Linking.addEventListener('url', async ({ url }) => {
          if (!url.startsWith('viralcut://tiktok-callback')) return;
          cleanup();

          try {
            const urlObj = new URL(url);
            const code = urlObj.searchParams.get('code');
            const errorParam = urlObj.searchParams.get('error');

            if (errorParam) {
              setConnectingOAuth(false);
              return resolve({ error: `TikTok denied access: ${errorParam}` });
            }
            if (!code) {
              setConnectingOAuth(false);
              return resolve({ error: 'No authorization code received from TikTok' });
            }

            const exchangeResult = await exchangeTikTokCode(
              code,
              TIKTOK_REDIRECT_URI,
              codeVerifierRef.current,
              user!.id,
            );

            if ('error' in exchangeResult) {
              setConnectingOAuth(false);
              return resolve({ error: exchangeResult.error });
            }

            await loadStatus();
            setConnectingOAuth(false);
            resolve({});
          } catch (e: any) {
            setConnectingOAuth(false);
            resolve({ error: String(e?.message ?? e) });
          }
        });

        // Open TikTok OAuth in system browser — don't await the result
        // because on mobile the browser closes via the deep-link, not via return URL capture
        WebBrowser.openBrowserAsync(result.authUrl, {
          showTitle: false,
          enableBarCollapsing: true,
        }).then((browserResult) => {
          // Browser dismissed without a deep-link (user cancelled manually)
          if (browserResult.type === 'cancel' || browserResult.type === 'dismiss') {
            cleanup();
            setConnectingOAuth(false);
            resolve({ error: 'OAuth cancelled' });
          }
        }).catch(() => {
          cleanup();
          setConnectingOAuth(false);
          resolve({ error: 'Failed to open browser' });
        });

      } catch (e: any) {
        cleanup();
        setConnectingOAuth(false);
        resolve({ error: String(e?.message ?? e) });
      }
    });
  }, [user?.id, loadStatus]);

  // ── Disconnect ────────────────────────────────────────────────────────────
  const disconnect = useCallback(async (): Promise<{ error?: string }> => {
    if (!user?.id) return { error: 'Not logged in' };
    const { error } = await disconnectTikTok(user.id);
    if (!error) setStatus({ connected: false });
    return { error };
  }, [user?.id]);

  // ── Publish Video ─────────────────────────────────────────────────────────
  /**
   * videoUrl must be a publicly accessible URL.
   * Local file:// URIs cannot be sent to TikTok's API — you must upload to
   * Supabase Storage first and pass the public URL here.
   */
  const publish = useCallback(async (
    videoUrl: string,
    title: string,
    privacyLevel: string = 'SELF_ONLY',
  ): Promise<{ publishId?: string; error?: string }> => {
    if (!user?.id) return { error: 'Not logged in' };
    if (!status.connected) return { error: 'TikTok not connected' };

    setPublishState({ phase: 'uploading' });

    const { publishId, error } = await publishToTikTok(user.id, videoUrl, title, privacyLevel);
    if (error) {
      setPublishState({ phase: 'error', errorMessage: error });
      return { error };
    }

    setPublishState({ phase: 'processing', publishId });
    startPolling(publishId!);
    return { publishId };
  }, [user?.id, status.connected]);

  // Poll TikTok status until done or max attempts
  const startPolling = (publishId: string) => {
    let attempts = 0;
    const MAX = 20; // poll up to 20 × 5s = 100 seconds

    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      attempts++;
      if (!user?.id || attempts > MAX) {
        clearInterval(pollRef.current!);
        setPublishState(prev =>
          prev.phase === 'processing'
            ? { phase: 'error', publishId, errorMessage: 'Timed out waiting for TikTok to process your video.' }
            : prev
        );
        return;
      }

      const { status: s, error } = await getTikTokPublishStatus(user.id, publishId);
      if (error) return; // transient — keep polling

      if (s === 'PUBLISH_COMPLETE' || s === 'SUCCESS') {
        clearInterval(pollRef.current!);
        setPublishState({ phase: 'success', publishId });
      } else if (s === 'FAILED' || s === 'PUBLISH_FAILED') {
        clearInterval(pollRef.current!);
        setPublishState({ phase: 'error', publishId, errorMessage: 'TikTok rejected the video. Check format and try again.' });
      }
    }, 5000);
  };

  const resetPublish = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setPublishState({ phase: 'idle' });
  }, []);

  return {
    status,
    loadingStatus,
    connectingOAuth,
    publishState,
    connect,
    disconnect,
    publish,
    resetPublish,
    loadStatus,
  };
}
