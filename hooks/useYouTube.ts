import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/template';
import {
  YouTubeStatus,
  getYouTubeStatus,
  disconnectYouTube,
  buildGoogleAuthUrl,
  exchangeYouTubeCode,
  generateCodeVerifier,
  generateCodeChallenge,
  YOUTUBE_REDIRECT_URI,
} from '@/services/youtubeService';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';

export type YTPublishPhase = 'idle' | 'burning' | 'uploading' | 'success' | 'error';

export interface YTPublishState {
  phase: YTPublishPhase;
  progress?: number;
  errorMessage?: string;
}

export function useYouTube() {
  const { user } = useAuth();
  const [status, setStatus] = useState<YouTubeStatus>({ connected: false });
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [connectingOAuth, setConnectingOAuth] = useState(false);
  const [publishState, setPublishState] = useState<YTPublishState>({ phase: 'idle' });
  const codeVerifierRef = useRef<string>('');

  const loadStatus = useCallback(async () => {
    if (!user?.id) return;
    setLoadingStatus(true);
    const s = await getYouTubeStatus(user.id);
    setStatus(s);
    setLoadingStatus(false);
  }, [user?.id]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const connect = useCallback((): Promise<{ error?: string }> => {
    return new Promise(async (resolve) => {
      if (!user?.id) return resolve({ error: 'Not logged in' });
      setConnectingOAuth(true);

      try {
        const verifier = generateCodeVerifier();
        codeVerifierRef.current = verifier;
        const challenge = await generateCodeChallenge(verifier);
        const state = Crypto.randomUUID();
        const authUrl = buildGoogleAuthUrl(challenge, state);

        // openAuthSessionAsync closes the browser when the custom scheme is detected
        const browserResult = await WebBrowser.openAuthSessionAsync(
          authUrl,
          YOUTUBE_REDIRECT_URI,
        );

        if (browserResult.type !== 'success') {
          setConnectingOAuth(false);
          return resolve({ error: 'Google sign-in was cancelled' });
        }

        const urlObj = new URL(browserResult.url);
        const code = urlObj.searchParams.get('code');
        const errorParam = urlObj.searchParams.get('error');

        if (errorParam) {
          setConnectingOAuth(false);
          return resolve({ error: `Google denied access: ${errorParam}` });
        }
        if (!code) {
          setConnectingOAuth(false);
          return resolve({ error: 'No authorization code received from Google' });
        }

        const result = await exchangeYouTubeCode(code, codeVerifierRef.current, user.id);
        if ('error' in result) {
          setConnectingOAuth(false);
          return resolve({ error: result.error });
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

  const disconnect = useCallback(async (): Promise<{ error?: string }> => {
    if (!user?.id) return { error: 'Not logged in' };
    const { error } = await disconnectYouTube(user.id);
    if (!error) setStatus({ connected: false });
    return { error };
  }, [user?.id]);

  const resetPublish = useCallback(() => {
    setPublishState({ phase: 'idle' });
  }, []);

  return {
    status,
    loadingStatus,
    connectingOAuth,
    publishState,
    setPublishState,
    connect,
    disconnect,
    resetPublish,
    loadStatus,
  };
}
