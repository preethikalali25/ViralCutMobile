import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/template';
import {
  InstagramStatus,
  getInstagramStatus,
  disconnectInstagram,
  getInstagramAuthUrl,
  exchangeInstagramCode,
  createReelContainer,
  getReelContainerStatus,
  finalizeReel,
} from '@/services/instagramService';
import * as WebBrowser from 'expo-web-browser';

export const INSTAGRAM_REDIRECT_URI =
  'https://gohuutzixvtavhdtdyon.supabase.co/functions/v1/instagram-publisher';

export type PublishPhase = 'idle' | 'uploading' | 'processing' | 'publishing' | 'success' | 'error';

export interface PublishState {
  phase: PublishPhase;
  containerId?: string;
  errorMessage?: string;
}

export function useInstagram() {
  const { user } = useAuth();
  const [status, setStatus] = useState<InstagramStatus>({ connected: false });
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [connectingOAuth, setConnectingOAuth] = useState(false);
  const [publishState, setPublishState] = useState<PublishState>({ phase: 'idle' });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    if (!user?.id) return;
    setLoadingStatus(true);
    const s = await getInstagramStatus(user.id);
    setStatus(s);
    setLoadingStatus(false);
  }, [user?.id]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // ── OAuth Connect ─────────────────────────────────────────────────────────
  const connect = useCallback(async (): Promise<{ error?: string }> => {
    if (!user?.id) return { error: 'Not logged in' };
    setConnectingOAuth(true);

    try {
      const result = await getInstagramAuthUrl(INSTAGRAM_REDIRECT_URI);
      if ('error' in result) {
        setConnectingOAuth(false);
        return { error: result.error };
      }

      // openAuthSessionAsync uses ASWebAuthenticationSession on iOS which
      // properly intercepts the viralcut:// callback URL without needing Linking.
      const browserResult = await WebBrowser.openAuthSessionAsync(
        result.authUrl,
        'viralcut://',
      );

      if (browserResult.type !== 'success') {
        setConnectingOAuth(false);
        return { error: 'OAuth cancelled' };
      }

      const urlObj = new URL(browserResult.url);
      const code = urlObj.searchParams.get('code');
      const errorParam = urlObj.searchParams.get('error');

      if (errorParam) {
        setConnectingOAuth(false);
        return { error: `Instagram denied access: ${errorParam}` };
      }
      if (!code) {
        setConnectingOAuth(false);
        return { error: 'No authorization code received' };
      }

      const exchangeResult = await exchangeInstagramCode(code, INSTAGRAM_REDIRECT_URI, user.id);
      if ('error' in exchangeResult) {
        setConnectingOAuth(false);
        return { error: exchangeResult.error };
      }

      await loadStatus();
      setConnectingOAuth(false);
      return {};
    } catch (e: any) {
      setConnectingOAuth(false);
      return { error: String(e?.message ?? e) };
    }
  }, [user?.id, loadStatus]);

  // ── Disconnect ────────────────────────────────────────────────────────────
  const disconnect = useCallback(async (): Promise<{ error?: string }> => {
    if (!user?.id) return { error: 'Not logged in' };
    const { error } = await disconnectInstagram(user.id);
    if (!error) setStatus({ connected: false });
    return { error };
  }, [user?.id]);

  // ── Publish Reel ──────────────────────────────────────────────────────────
  const publish = useCallback(async (
    videoUrl: string,
    caption: string,
  ): Promise<{ containerId?: string; error?: string }> => {
    if (!user?.id) return { error: 'Not logged in' };
    if (!status.connected) return { error: 'Instagram not connected' };

    setPublishState({ phase: 'uploading' });

    const { containerId, error } = await createReelContainer(user.id, videoUrl, caption);
    if (error) {
      setPublishState({ phase: 'error', errorMessage: error });
      return { error };
    }

    setPublishState({ phase: 'processing', containerId });
    startPolling(containerId!);
    return { containerId };
  }, [user?.id, status.connected]);

  const startPolling = (containerId: string) => {
    let attempts = 0;
    const MAX = 24;

    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      attempts++;
      if (!user?.id || attempts > MAX) {
        clearInterval(pollRef.current!);
        setPublishState(prev =>
          prev.phase === 'processing'
            ? { phase: 'error', containerId, errorMessage: 'Timed out waiting for Instagram to process your Reel.' }
            : prev,
        );
        return;
      }

      const { statusCode, error } = await getReelContainerStatus(user.id, containerId);
      if (error) return;

      if (statusCode === 'FINISHED') {
        clearInterval(pollRef.current!);
        setPublishState({ phase: 'publishing', containerId });
        const { mediaId, error: finalizeError } = await finalizeReel(user.id, containerId);
        if (finalizeError) {
          setPublishState({ phase: 'error', containerId, errorMessage: finalizeError });
        } else {
          setPublishState({ phase: 'success', containerId });
        }
      } else if (statusCode === 'ERROR') {
        clearInterval(pollRef.current!);
        setPublishState({
          phase: 'error',
          containerId,
          errorMessage: 'Instagram rejected the Reel. Ensure the video is MP4/H.264, at least 3 seconds, and under 15 minutes.',
        });
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
