import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/template';
import {
  InstagramStatus,
  getInstagramStatus,
  disconnectInstagram,
  getInstagramAuthUrl,
  exchangeInstagramCode,
  createInstagramContainer,
  getContainerStatus,
  publishInstagramContainer,
} from '@/services/instagramService';
import * as WebBrowser from 'expo-web-browser';

// Backend URL that Instagram redirects to, then this forwards to viralcut://instagram-callback
export const INSTAGRAM_REDIRECT_URI =
  'https://mrsvovoywukechawmrsv.backend.onspace.ai/functions/v1/instagram-publisher';

export type IGPublishPhase =
  | 'idle'
  | 'uploading'       // uploading video to storage
  | 'creating'        // creating IG media container
  | 'processing'      // polling container status
  | 'publishing'      // calling media_publish
  | 'success'
  | 'error';

export interface IGPublishState {
  phase: IGPublishPhase;
  containerId?: string;
  mediaId?: string;
  errorMessage?: string;
}

export function useInstagram() {
  const { user } = useAuth();
  const [status, setStatus] = useState<InstagramStatus>({ connected: false });
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [connectingOAuth, setConnectingOAuth] = useState(false);
  const [publishState, setPublishState] = useState<IGPublishState>({ phase: 'idle' });
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

  // ── OAuth Connect ──────────────────────────────────────────────────────────
  const connect = useCallback((): Promise<{ error?: string }> => {
    return new Promise(async (resolve) => {
      if (!user?.id) return resolve({ error: 'Not logged in' });
      setConnectingOAuth(true);

      try {
        const result = await getInstagramAuthUrl(INSTAGRAM_REDIRECT_URI);
        if ('error' in result) {
          setConnectingOAuth(false);
          return resolve({ error: result.error });
        }

        // openAuthSessionAsync detects the viralcut:// redirect and returns it
        // instead of treating it as a browser dismissal
        const browserResult = await WebBrowser.openAuthSessionAsync(
          result.authUrl,
          'viralcut://',
        );

        if (browserResult.type !== 'success') {
          setConnectingOAuth(false);
          return resolve({ error: 'OAuth cancelled' });
        }

        const urlObj = new URL(browserResult.url);
        const code = urlObj.searchParams.get('code');
        const errorParam = urlObj.searchParams.get('error');

        if (errorParam) {
          setConnectingOAuth(false);
          return resolve({ error: `Instagram denied access: ${errorParam}` });
        }
        if (!code) {
          setConnectingOAuth(false);
          return resolve({ error: 'No authorization code received from Instagram' });
        }

        const exchangeResult = await exchangeInstagramCode(
          code,
          INSTAGRAM_REDIRECT_URI,
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
  }, [user?.id, loadStatus]);

  // ── Disconnect ────────────────────────────────────────────────────────────
  const disconnect = useCallback(async (): Promise<{ error?: string }> => {
    if (!user?.id) return { error: 'Not logged in' };
    const { error } = await disconnectInstagram(user.id);
    if (!error) setStatus({ connected: false });
    return { error };
  }, [user?.id]);

  // ── Publish Reel ──────────────────────────────────────────────────────────
  /**
   * videoUrl must be a publicly accessible HTTPS URL.
   * Local file:// URIs must be uploaded to Supabase Storage first.
   */
  const publish = useCallback(async (
    videoUrl: string,
    caption: string,
    coverUrl?: string,
  ): Promise<{ mediaId?: string; error?: string }> => {
    if (!user?.id) return { error: 'Not logged in' };
    if (!status.connected) return { error: 'Instagram not connected' };

    setPublishState({ phase: 'creating' });

    // Step 1: Create media container
    const { containerId, error: containerErr } = await createInstagramContainer(
      user.id, videoUrl, caption, coverUrl,
    );

    if (containerErr || !containerId) {
      setPublishState({ phase: 'error', errorMessage: containerErr ?? 'Failed to create container' });
      return { error: containerErr ?? 'Failed to create container' };
    }

    setPublishState({ phase: 'processing', containerId });

    // Step 2: Poll until FINISHED
    const waitResult = await pollContainerStatus(user.id, containerId);
    if (waitResult.error) {
      setPublishState({ phase: 'error', containerId, errorMessage: waitResult.error });
      return { error: waitResult.error };
    }

    // Step 3: Publish
    setPublishState({ phase: 'publishing', containerId });
    const { mediaId, error: publishErr } = await publishInstagramContainer(user.id, containerId);
    if (publishErr || !mediaId) {
      setPublishState({ phase: 'error', containerId, errorMessage: publishErr ?? 'Publish failed' });
      return { error: publishErr ?? 'Publish failed' };
    }

    setPublishState({ phase: 'success', containerId, mediaId });
    return { mediaId };
  }, [user?.id, status.connected]);

  const pollContainerStatus = (userId: string, containerId: string): Promise<{ error?: string }> => {
    return new Promise((resolve) => {
      let attempts = 0;
      const MAX = 24; // 24 × 5s = 2 minutes

      if (pollRef.current) clearInterval(pollRef.current);

      pollRef.current = setInterval(async () => {
        attempts++;
        if (attempts > MAX) {
          clearInterval(pollRef.current!);
          return resolve({ error: 'Timed out waiting for Instagram to process the video.' });
        }

        const { statusCode, error } = await getContainerStatus(userId, containerId);
        if (error) return; // transient — keep polling

        console.log(`[instagram] container ${containerId} status: ${statusCode}`);

        if (statusCode === 'FINISHED') {
          clearInterval(pollRef.current!);
          resolve({});
        } else if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
          clearInterval(pollRef.current!);
          resolve({ error: `Instagram container ${statusCode.toLowerCase()}. Try again.` });
        }
        // IN_PROGRESS → keep polling
      }, 5000);
    });
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
