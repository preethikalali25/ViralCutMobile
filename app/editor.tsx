
import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator, Modal,
} from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useVideos } from '@/hooks/useVideos';
import { useAlert, getSupabaseClient, useAuth } from '@/template';
import { MOCK_TRENDING_AUDIO } from '@/constants/mockData';
import { Platform as PlatformType, HookType } from '@/types';
import PlatformBadge from '@/components/ui/PlatformBadge';
import StatusBadge from '@/components/ui/StatusBadge';
import { formatDuration } from '@/services/formatters';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { useTikTok } from '@/hooks/useTikTok';
import { useInstagram } from '@/hooks/useInstagram';
import { uploadVideoToStorage } from '@/services/tiktokService';
import { burnHookOverlay } from '@/services/videoOverlayService';
import * as FileSystem from 'expo-file-system';
import Slider from '@react-native-community/slider';

type Tab = 'hook' | 'caption' | 'audio' | 'platforms';

interface AISuggestedAudio {
  id: string;
  title: string;
  artist: string;
  uses: string;
  trending: boolean;
  platform: string[];
  mood: string;
  reason?: string;
}

const HOOK_TYPES: { type: HookType; label: string; desc: string; icon: string }[] = [
  { type: 'question', label: 'Question', desc: 'Curiosity hook', icon: 'help-outline' },
  { type: 'stat', label: 'Stat', desc: 'Shocking number', icon: 'bar-chart' },
  { type: 'visual', label: 'Visual', desc: 'Visual surprise', icon: 'visibility' },
];

const ALL_PLATFORMS: PlatformType[] = ['tiktok', 'reels', 'youtube'];

async function resolveVideoUri(uri: string): Promise<string> {
  if (!uri.startsWith('ph://')) return uri;
  try {
    const FS = await import('expo-file-system');
    const dest = FS.cacheDirectory + `vid_${Date.now()}.mp4`;
    await FS.copyAsync({ from: uri, to: dest });
    return dest;
  } catch (e) {
    console.warn('[resolveVideoUri] copyAsync failed, trying MediaLibrary:', e);
  }
  try {
    const MediaLibrary = await import('expo-media-library');
    const assetId = uri.replace('ph://', '').split('/')[0];
    const asset = await MediaLibrary.getAssetInfoAsync(assetId);
    if (asset?.localUri) return asset.localUri;
  } catch (e) {
    console.warn('[resolveVideoUri] MediaLibrary fallback failed:', e);
  }
  return uri;
}

async function extractVideoFrame(videoUri: string): Promise<{ base64: string; mime: string } | null> {
  try {
    const VideoThumbnails = await import('expo-video-thumbnails');
    const FileSystem = await import('expo-file-system');
    const resolvedUri = await resolveVideoUri(videoUri);
    let frameUri: string | null = null;
    for (const seekMs of [2000, 1000, 500, 0]) {
      try {
        const { uri } = await VideoThumbnails.getThumbnailAsync(resolvedUri, { time: seekMs, quality: 0.4, maxWidth: 512 });
        if (uri) { frameUri = uri; break; }
      } catch { /* try next */ }
    }
    if (!frameUri) return null;
    const base64 = await FileSystem.readAsStringAsync(frameUri, { encoding: FileSystem.EncodingType.Base64 });
    return { base64, mime: 'image/jpeg' };
  } catch (e) {
    console.warn('Frame extraction failed:', e);
    return null;
  }
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/\.[a-zA-Z0-9]{2,5}$/, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\b\d{4,}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || 'my video';
}

async function fetchItunesPreviewUrl(title: string, artist: string): Promise<string | null> {
  const trySearch = async (q: string): Promise<string | null> => {
    try {
      const encoded = encodeURIComponent(q);
      // Promise.race timeout — more compatible with RN's fetch than AbortController.signal
      const timeoutP = new Promise<null>(resolve => setTimeout(() => resolve(null), 10000));
      const fetchP = fetch(
        `https://itunes.apple.com/search?term=${encoded}&media=music&limit=5&country=US`,
      ).then(async r => {
        if (!r.ok) return null;
        const d = await r.json();
        return (d.results?.[0]?.previewUrl as string) ?? null;
      }).catch(() => null);
      return await Promise.race([fetchP, timeoutP]);
    } catch {
      return null;
    }
  };

  // Take first artist when multiple are listed (e.g. "ROSE & Bruno Mars" → "ROSE")
  const firstArtist = artist.split(/[&,]/)[0].trim();
  const cleanTitle  = title.replace(/[.!?]+$/, '').trim();

  return (
    (await trySearch(`${cleanTitle} ${firstArtist}`)) ??
    (await trySearch(cleanTitle)) ??
    (await trySearch(`${title} ${artist}`))
  );
}

async function callAIGenerator(type: string, payload: Record<string, unknown>) {
  const client = getSupabaseClient();

  const attempt = async (body: Record<string, unknown>) => {
    const { data, error } = await client.functions.invoke('ai-content-generator', { body });
    if (error) {
      let msg = error.message;
      if (error instanceof FunctionsHttpError) {
        try { const text = await error.context?.text(); msg = text || msg; } catch { /* ignore */ }
      }
      return { data: null, error: msg };
    }
    return { data, error: null };
  };

  // First try with full payload (may include frame)
  const first = await attempt({ type, ...payload });
  if (!first.error) return first;

  // If it timed out and we sent a frame, retry without the frame
  const hasFrame = 'videoFrameBase64' in payload;
  if (hasFrame && (first.error.includes('504') || first.error.includes('timeout') || first.error.includes('Gateway'))) {
    console.warn('[AI] frame attempt timed out, retrying without frame');
    const { videoFrameBase64: _f, videoFrameMime: _m, ...payloadWithoutFrame } = payload as any;
    return attempt({ type, ...payloadWithoutFrame });
  }

  return first;
}

export default function EditorScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { videos, updateVideo } = useVideos();
  const { showAlert } = useAlert();
  const { user } = useAuth();

  const video = videos.find(v => v.id === id) ?? videos.find(v => v.status === 'ready' || v.status === 'published');

  const [tab, setTab] = useState<Tab>('hook');
  const [hookType, setHookType] = useState<HookType>('question');
  const [hookText, setHookText] = useState('');
  const [caption, setCaption] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [selectedAudioId, setSelectedAudioId] = useState('');
  const [platforms, setPlatforms] = useState<PlatformType[]>(['tiktok']);
  const hookSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [generatingHook, setGeneratingHook] = useState(false);
  const [generatingCaption, setGeneratingCaption] = useState(false);
  const [generatingAudio, setGeneratingAudio] = useState(false);
  const [aiPickedSong, setAiPickedSong] = useState<AISuggestedAudio | null>(null);
  const [autoGenDone, setAutoGenDone] = useState(false);

  const [showPlayer, setShowPlayer] = useState(false);
  const [videoTitle, setVideoTitle] = useState('');
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const [showTikTokSheet, setShowTikTokSheet] = useState(false);
  const [showInstagramSheet, setShowInstagramSheet] = useState(false);
  const [tiktokPrivacy, setTiktokPrivacy] = useState('SELF_ONLY');
  const [uploadingToStorage, setUploadingToStorage] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [burningOverlay, setBurningOverlay] = useState(false);
  const [burnAudioLabel, setBurnAudioLabel] = useState<string | null>(null);
  const [generatingThumbnail, setGeneratingThumbnail] = useState(false);
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(video?.thumbnail ?? null);

  // Audio mix volumes: 0.0–1.0 each. Shown as sliders in the Audio tab.
  const [originalVolume, setOriginalVolume] = useState(0.6); // original voice
  const [bgVolume, setBgVolume] = useState(0.8);             // background music

  // Eagerly pre-fetched local path for the selected song's iTunes 30-s preview.
  const [cachedAudioUri, setCachedAudioUri] = useState<string | null>(null);
  // Ref mirrors the state so async functions (which close over stale state)
  // always read the latest downloaded URI without needing a re-render.
  const cachedAudioUriRef = useRef<string | null>(null);
  const [audioStatus, setAudioStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  // Use title+artist as the dedup key — AI always returns id='ai_best' so id alone isn't unique.
  const cachedAudioKey = useRef<string>('');
  // Holds the in-progress (or already-resolved) prefetch Promise so publish can
  // await it if the user taps publish before the download finishes.
  const audioFetchPromise = useRef<Promise<string | null>>(Promise.resolve(null));

  const prefetchAudioForSong = useCallback((id: string, title: string, artist: string) => {
    const key = `${title}::${artist}`;
    if (key === cachedAudioKey.current) return;
    cachedAudioKey.current = key;
    // Do NOT wipe cachedAudioUri here — keep the previous download as fallback
    // while the new one loads so we always have something to mix.
    setAudioStatus('loading');
    const p: Promise<string | null> = (async () => {
      try {
        const previewUrl = await fetchItunesPreviewUrl(title, artist);
        if (!previewUrl) {
          console.warn('[prefetchAudio] no iTunes preview for:', title, artist);
          setAudioStatus(prev => prev === 'loading' ? 'failed' : prev);
          return null;
        }
        const dest = `${FileSystem.cacheDirectory}bgaudio_${Date.now()}.m4a`;
        const dl = await FileSystem.downloadAsync(previewUrl, dest);
        if (dl.status === 200) {
          cachedAudioUriRef.current = dl.uri;
          setCachedAudioUri(dl.uri);
          setAudioStatus('ready');
          console.log('[prefetchAudio] ready:', dl.uri);
          return dl.uri;
        }
        console.warn('[prefetchAudio] download status:', dl.status);
        setAudioStatus(prev => prev === 'loading' ? 'failed' : prev);
        return null;
      } catch (e) {
        console.warn('[prefetchAudio] failed:', e);
        setAudioStatus(prev => prev === 'loading' ? 'failed' : prev);
        return null;
      }
    })();
    audioFetchPromise.current = p;
  }, []);

  // ── Edge Function Test Panel ──
  const [showTestModal, setShowTestModal] = useState(false);
  type TestKey = 'ai-content-generator' | 'wayinvideo-analyzer' | 'tiktok-publisher' | 'audio-pipeline';
  const [testLoading, setTestLoading] = useState<Record<TestKey, boolean>>({
    'ai-content-generator': false,
    'wayinvideo-analyzer': false,
    'tiktok-publisher': false,
    'audio-pipeline': false,
  });
  const [testResults, setTestResults] = useState<Record<TestKey, string | null>>({
    'ai-content-generator': null,
    'wayinvideo-analyzer': null,
    'tiktok-publisher': null,
    'audio-pipeline': null,
  });

  const runFunctionTest = async (fn: TestKey) => {
    setTestLoading(prev => ({ ...prev, [fn]: true }));
    setTestResults(prev => ({ ...prev, [fn]: null }));

    if (fn === 'audio-pipeline') {
      // End-to-end audio pipeline test: iTunes search → download → show result
      try {
        const song = MOCK_TRENDING_AUDIO[0]; // APT. by ROSE & Bruno Mars — known real song
        const steps: string[] = [];
        steps.push(`Searching iTunes: "${song.title}" by ${song.artist}`);
        const previewUrl = await fetchItunesPreviewUrl(song.title, song.artist);
        if (!previewUrl) {
          setTestResults(prev => ({ ...prev, [fn]: steps.concat('❌ No preview URL returned').join('\n') }));
          setTestLoading(prev => ({ ...prev, [fn]: false }));
          return;
        }
        steps.push(`✓ Preview URL: ${previewUrl.slice(0, 60)}...`);
        const dest = `${FileSystem.cacheDirectory}test_audio_${Date.now()}.m4a`;
        steps.push('Downloading preview...');
        const dl = await FileSystem.downloadAsync(previewUrl, dest);
        steps.push(`Download status: ${dl.status}`);
        if (dl.status === 200) {
          const info = await FileSystem.getInfoAsync(dl.uri, { size: true });
          steps.push(`✓ File size: ${(info as any).size ?? '?'} bytes`);
          steps.push(`✓ URI: ${dl.uri.split('/').slice(-2).join('/')}`);
          steps.push('');
          steps.push('cachedAudioUri: ' + (cachedAudioUri ? cachedAudioUri.split('/').pop() : 'null'));
        } else {
          steps.push('❌ Download failed');
        }
        setTestResults(prev => ({ ...prev, [fn]: steps.join('\n') }));
      } catch (e) {
        setTestResults(prev => ({ ...prev, [fn]: `EXCEPTION: ${String(e)}` }));
      }
      setTestLoading(prev => ({ ...prev, [fn]: false }));
      return;
    }

    const client = getSupabaseClient();
    try {
      let body: Record<string, unknown> = {};
      if (fn === 'ai-content-generator') {
        body = { type: 'hook', videoTitle: 'test video', hookType: 'question', platforms: ['tiktok'] };
      } else if (fn === 'wayinvideo-analyzer') {
        body = { action: 'ping' };
      } else if (fn === 'tiktok-publisher') {
        body = { action: 'status' };
      }
      const { data, error } = await client.functions.invoke(fn, { body });
      if (error) {
        let errMsg = error.message;
        if (error instanceof FunctionsHttpError) {
          try { const t = await error.context?.text(); errMsg = `[${error.context?.status}] ${t || errMsg}`; } catch { /* ignore */ }
        }
        setTestResults(prev => ({ ...prev, [fn]: `ERROR: ${errMsg}` }));
      } else {
        setTestResults(prev => ({ ...prev, [fn]: JSON.stringify(data, null, 2) }));
      }
    } catch (e) {
      setTestResults(prev => ({ ...prev, [fn]: `EXCEPTION: ${String(e)}` }));
    }
    setTestLoading(prev => ({ ...prev, [fn]: false }));
  };

  const frameCache = useRef<{ base64: string; mime: string } | null | 'pending'>('pending');
  const tiktok = useTikTok();
  const instagram = useInstagram();

  const videoPlayer = useVideoPlayer(
    { uri: video?.videoUri ?? '' },
    player => { if (player) player.loop = false; }
  );

  useEffect(() => {
    if (!video) return;
    setVideoTitle(video.title ?? '');
    setHookType(video.hook?.type ?? 'question');
    setHookText(video.hook?.text ?? '');
    setCaption(video.caption ?? '');
    setHashtags(video.hashtags?.join(' ') ?? '');
    setSelectedAudioId(video.audio?.id ?? '');
    setPlatforms(video.platforms ?? ['tiktok']);
    setThumbnailUri(video.thumbnail ?? null);
    if (video.audio?.title && video.audio?.artist) {
      prefetchAudioForSong(video.audio.id ?? 'saved', video.audio.title, video.audio.artist);
    } else {
      // No saved audio yet — pre-warm with the first MOCK song so there's always
      // something ready while the AI generator runs.
      prefetchAudioForSong(MOCK_TRENDING_AUDIO[0].id, MOCK_TRENDING_AUDIO[0].title, MOCK_TRENDING_AUDIO[0].artist);
    }
  }, [video?.id]);

  // Auto-generate hook, caption, and audio on first open
  useEffect(() => {
    if (!video || autoGenDone) return;
    const needsHook = !(video.hook?.text?.trim());
    const needsCaption = !(video.caption?.trim());
    const needsAudio = !video.audio?.id;
    if (!needsHook && !needsCaption && !needsAudio) return;
    setAutoGenDone(true);

    const runAll = async () => {
      const frame = video.videoUri ? await extractVideoFrame(video.videoUri) : null;
      frameCache.current = frame;
      const framePayload = frame ? { videoFrameBase64: frame.base64, videoFrameMime: frame.mime } : {};

      if (needsHook) {
        const { data } = await callAIGenerator('hook', {
          videoTitle: cleanTitle(video.title), hookType: 'question',
          platforms: video.platforms ?? ['tiktok'], ...framePayload,
        });
        if (data?.result) {
          setHookText(data.result);
          updateVideo(video.id, { hook: { type: 'question', text: data.result } });
        }
      }

      if (needsCaption) {
        const { data } = await callAIGenerator('caption', {
          videoTitle: cleanTitle(video.title), platforms: video.platforms ?? ['tiktok'], ...framePayload,
        });
        if (data?.result?.caption) {
          setCaption(data.result.caption);
          if (data.result.hashtags) setHashtags(data.result.hashtags);
        }
      }

      if (needsAudio) {
        setGeneratingAudio(true);
        const { data } = await callAIGenerator('audio', {
          videoTitle: cleanTitle(video.title), platforms: video.platforms ?? ['tiktok'], ...framePayload,
        });
        setGeneratingAudio(false);
        if (data?.result?.id) {
          setAiPickedSong(data.result);
          setSelectedAudioId(data.result.id);
          prefetchAudioForSong(data.result.id, data.result.title, data.result.artist);
        }
      }
    };

    runAll();
  }, [video?.id]);

  if (!video) {
    return (
      <SafeAreaView style={[styles.safe, { alignItems: 'center', justifyContent: 'center', gap: 12 }]}>
        <MaterialIcons name="video-library" size={52} color={Colors.textMuted} />
        <Text style={styles.emptyTitle}>No video selected</Text>
        <Pressable style={styles.uploadBtn} onPress={() => router.replace('/upload')}>
          <Text style={styles.uploadBtnText}>Upload Video</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const ensureFrame = async () => {
    if (frameCache.current === 'pending') {
      frameCache.current = video.videoUri ? await extractVideoFrame(video.videoUri) : null;
    }
    const frame = frameCache.current !== 'pending' ? frameCache.current : null;
    return frame ? { videoFrameBase64: frame.base64, videoFrameMime: frame.mime } : {};
  };

  const handleGenerateHook = async () => {
    setGeneratingHook(true);
    const framePayload = await ensureFrame();
    const { data, error } = await callAIGenerator('hook', {
      videoTitle: cleanTitle(video.title), hookType, platforms, ...framePayload,
    });
    setGeneratingHook(false);
    if (error) { showAlert('AI Error', error); return; }
    if (data?.result) {
      setHookText(data.result);
      updateVideo(video.id, { hook: { type: hookType, text: data.result } });
    }
  };

  const handleGenerateCaption = async () => {
    setGeneratingCaption(true);
    const framePayload = await ensureFrame();
    const { data, error } = await callAIGenerator('caption', {
      videoTitle: cleanTitle(video.title), platforms, ...framePayload,
    });
    setGeneratingCaption(false);
    if (error) { showAlert('AI Error', 'Could not generate caption. Please try again.'); return; }
    const result = data?.result;
    if (result?.caption) setCaption(result.caption);
    if (result?.hashtags) setHashtags(result.hashtags);
  };

  const handleGenerateAudio = useCallback(async () => {
    setGeneratingAudio(true);
    const framePayload = await ensureFrame();
    const { data, error } = await callAIGenerator('audio', {
      videoTitle: cleanTitle(video.title), platforms, ...framePayload,
    });
    setGeneratingAudio(false);
    if (error) { showAlert('AI Error', error); return; }
    const song = data?.result;
    if (song?.id) {
      setAiPickedSong(song);
      setSelectedAudioId(song.id);
      prefetchAudioForSong(song.id, song.title, song.artist);
    }
  }, [video.title, platforms, showAlert, prefetchAudioForSong]);

  const handleGenerateTitle = useCallback(async () => {
    setGeneratingTitle(true);
    const framePayload = await ensureFrame();
    const { data, error } = await callAIGenerator('title', {
      videoTitle: cleanTitle(video?.title ?? ''), ...framePayload,
    });
    setGeneratingTitle(false);
    if (error) { showAlert('AI Error', error); return; }
    if (data?.result) {
      setVideoTitle(data.result);
      updateVideo(video.id, { title: data.result });
    }
  }, [video, showAlert, updateVideo]);

  const snapshotEditorState = () => {
    const audioSource = aiPickedSong && selectedAudioId === aiPickedSong.id
      ? aiPickedSong
      : MOCK_TRENDING_AUDIO.find(a => a.id === selectedAudioId);
    return {
      hook: { type: hookType, text: hookText },
      caption,
      hashtags: hashtags.split(/\s+/).filter(Boolean),
      platforms,
      audio: audioSource
        ? { id: audioSource.id, title: audioSource.title, artist: audioSource.artist, uses: audioSource.uses, trending: audioSource.trending }
        : undefined,
    };
  };

  const handleSave = () => {
    const snap = snapshotEditorState();
    updateVideo(video.id, { ...snap, title: videoTitle });
    showAlert('Saved', 'Your changes have been saved.');
  };

  const handleSchedule = () => {
    const snap = snapshotEditorState();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(12, 0, 0, 0);
    updateVideo(video.id, { ...snap, status: 'scheduled', scheduledAt: tomorrow.toISOString() });
    showAlert('Scheduled!', 'Your video is scheduled for tomorrow at 12:00 PM.', [
      { text: 'View Schedule', onPress: () => router.push('/(tabs)/schedule') },
      { text: 'OK', style: 'cancel' },
    ]);
  };

  const prepareVideoForPublish = async (
    videoUri: string,
    hookText: string,
  ): Promise<{ videoUrl?: string; error?: string }> => {
    try {
      setUploadingToStorage(true);
      setBurningOverlay(true);
      setBurnAudioLabel('searching…');

      const burnUri = video.videoAssetId
        ? `ph://${video.videoAssetId}`
        : videoUri;

      // Determine which song to use: AI pick > user selection > first MOCK track.
      const snap2 = snapshotEditorState();
      const audioSong = snap2.audio ?? {
        title: MOCK_TRENDING_AUDIO[0].title,
        artist: MOCK_TRENDING_AUDIO[0].artist,
      };

      // 1. Await any in-flight prefetch so we don't race with it.
      //    audioFetchPromise.current is always set to the latest prefetch, resolved or pending.
      setBurnAudioLabel(`Finding music…`);
      const prefetchedUri = await audioFetchPromise.current;

      // 2. Prefer in-flight result → ref (latest state, avoids stale closure) → state.
      let backgroundAudioUri: string | undefined =
        prefetchedUri ?? cachedAudioUriRef.current ?? cachedAudioUri ?? undefined;

      // 3. If still nothing, do a fresh search. Try the AI/selected song first,
      //    then fall back through MOCK_TRENDING_AUDIO to guarantee we always have music.
      if (!backgroundAudioUri) {
        const fallbackSongs = [
          { title: audioSong.title, artist: audioSong.artist },
          ...MOCK_TRENDING_AUDIO.map(s => ({ title: s.title, artist: s.artist })),
        ];

        for (const song of fallbackSongs) {
          setBurnAudioLabel(`Searching: ${song.title}…`);
          try {
            const previewUrl = await fetchItunesPreviewUrl(song.title, song.artist);
            if (!previewUrl) {
              console.warn('[burn] no iTunes preview for:', song.title, song.artist);
              continue;
            }
            setBurnAudioLabel(`Downloading: ${song.title}…`);
            const dest = `${FileSystem.cacheDirectory}bgburn_${Date.now()}.m4a`;
            const dl = await FileSystem.downloadAsync(previewUrl, dest);
            if (dl.status === 200) {
              backgroundAudioUri = dl.uri;
              cachedAudioUriRef.current = dl.uri;
              setCachedAudioUri(dl.uri);
              console.log('[burn] fallback audio ready:', song.title, dl.uri);
              break;
            }
            console.warn('[burn] download status', dl.status, 'for', song.title);
          } catch (audioErr) {
            console.warn('[burn] fetch error for', song.title, audioErr);
          }
        }
      }

      const label = backgroundAudioUri
        ? `${audioSong.title} – ${audioSong.artist}`
        : 'no music (preview unavailable)';
      setBurnAudioLabel(label);
      console.log('[burn] backgroundAudioUri going to native:', backgroundAudioUri ?? 'NONE');

      const { outputUri: burnedUri } = await burnHookOverlay(burnUri, hookText, backgroundAudioUri, originalVolume, bgVolume);
      setBurningOverlay(false);
      const resolvedUri = await resolveVideoUri(burnedUri);
      const { publicUrl, error } = await uploadVideoToStorage(resolvedUri, user!.id, video.id, (p) => setUploadProgress(p));
      setUploadingToStorage(false);
      if (error || !publicUrl) return { error: error ?? 'Upload failed' };
      return { videoUrl: publicUrl };
    } catch (e: any) {
      setBurningOverlay(false);
      setUploadingToStorage(false);
      return { error: String(e?.message ?? e) };
    }
  };

  const handlePublish = () => {
    const snap = snapshotEditorState();
    const hasTikTok = platforms.includes('tiktok') && tiktok.status.connected;
    const hasInstagram = platforms.includes('reels') && instagram.status.connected;

    if (hasTikTok || hasInstagram) {
      // Show platform picker if multiple connected
      const options: { text: string; onPress: () => void }[] = [];
      if (hasTikTok) options.push({ text: 'Publish to TikTok', onPress: () => setShowTikTokSheet(true) });
      if (hasInstagram) options.push({ text: 'Publish to Instagram Reels', onPress: () => setShowInstagramSheet(true) });

      if (options.length === 1) {
        options[0].onPress();
        return;
      }

      showAlert('Publish To...', 'Select a platform to publish your video.', [
        ...options,
        { text: 'Cancel', style: 'cancel' },
      ]);
      return;
    }

    showAlert('Publish Now?', 'This will publish your video locally.', [
      {
        text: 'Publish', onPress: () => {
          updateVideo(video.id, { ...snap, status: 'published', publishedAt: new Date().toISOString() });
          router.push('/(tabs)/library');
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleTikTokPublish = async () => {
    const snap = snapshotEditorState();
    if (!video?.videoUri) { showAlert('No Video File', 'Select a video before publishing to TikTok.'); return; }

    const { videoUrl, error: prepError } = await prepareVideoForPublish(video.videoUri, snap.hook?.text ?? '');
    if (prepError || !videoUrl) { showAlert('Upload Failed', prepError ?? 'Could not upload video.'); return; }

    updateVideo(video.id, { ...snap, title: videoTitle });
    const { error } = await tiktok.publish(
      videoUrl, videoTitle || snap.hook.text || 'ViralCut video', tiktokPrivacy,
    );
    if (error) showAlert('TikTok Error', error);
  };

  const handleInstagramPublish = async () => {
    const snap = snapshotEditorState();
    if (!video?.videoUri) { showAlert('No Video File', 'Select a video before publishing to Instagram.'); return; }

    const { videoUrl, error: prepError } = await prepareVideoForPublish(video.videoUri, snap.hook?.text ?? '');
    if (prepError || !videoUrl) { showAlert('Upload Failed', prepError ?? 'Could not upload video.'); return; }

    const captionText = [snap.caption, snap.hashtags.join(' ')].filter(Boolean).join('\n\n');
    updateVideo(video.id, { ...snap, title: videoTitle });
    const { error } = await instagram.publish(videoUrl, captionText);
    if (error) showAlert('Instagram Error', error);
  };

  const togglePlatform = (p: PlatformType) => {
    setPlatforms(prev =>
      prev.includes(p) ? (prev.length > 1 ? prev.filter(x => x !== p) : prev) : [...prev, p]
    );
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: 'hook', label: 'Hook' },
    { id: 'caption', label: 'Caption' },
    { id: 'audio', label: 'Audio' },
    { id: 'platforms', label: 'Platforms' },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable style={styles.backBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={20} color={Colors.textSecondary} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle} numberOfLines={1}>{videoTitle || video.title}</Text>
            <View style={styles.headerMeta}>
              <StatusBadge status={video.status} />
              <Text style={styles.duration}>{formatDuration(video.duration)}</Text>
            </View>
          </View>
          <Pressable
            style={({ pressed }) => [styles.testIconBtn, pressed && { opacity: 0.7 }]}
            onPress={() => setShowTestModal(true)}
            hitSlop={6}
          >
            <MaterialIcons name="bug-report" size={18} color={Colors.amber} />
          </Pressable>
          <Pressable style={({ pressed }) => [styles.saveBtn, pressed && { opacity: 0.8 }]} onPress={handleSave}>
            <Text style={styles.saveBtnText}>Save</Text>
          </Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false}>
          {/* Smart Title */}
          <View style={styles.titleRow}>
            <TextInput
              style={styles.titleInput}
              value={videoTitle}
              onChangeText={setVideoTitle}
              placeholder="Video title..."
              placeholderTextColor={Colors.textMuted}
              returnKeyType="done"
              maxLength={120}
            />
            <Pressable
              style={({ pressed }) => [styles.titleAiBtn, pressed && { opacity: 0.8 }, generatingTitle && { opacity: 0.6 }]}
              onPress={handleGenerateTitle}
              disabled={generatingTitle}
              hitSlop={6}
            >
              {generatingTitle
                ? <ActivityIndicator size="small" color={Colors.primaryLight} />
                : <MaterialCommunityIcons name="auto-fix" size={17} color={Colors.primaryLight} />}
            </Pressable>
          </View>

          {/* Thumbnail Preview */}
          <View style={styles.previewContainer}>
            <View style={styles.preview}>
              {thumbnailUri ? (
                <Image source={{ uri: thumbnailUri }} style={styles.previewImg} contentFit="cover" transition={200} />
              ) : (
                <View style={[styles.previewImg, { backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' }]}>
                  <MaterialIcons name="videocam" size={36} color={Colors.textMuted} />
                </View>
              )}
              {hookText ? (
                <View style={styles.hookOverlay}>
                  <Text style={styles.hookOverlayText}>{hookText}</Text>
                </View>
              ) : null}
              <Pressable style={styles.playBtn} onPress={() => setShowPlayer(true)} hitSlop={8}>
                <MaterialIcons name="play-circle-filled" size={44} color="rgba(255,255,255,0.9)" />
              </Pressable>
              <Pressable
                style={styles.thumbRefreshBtn}
                onPress={async () => {
                  if (!video?.videoUri || generatingThumbnail) return;
                  setGeneratingThumbnail(true);
                  try {
                    const VideoThumbnails = await import('expo-video-thumbnails');
                    const resolved = await resolveVideoUri(video.videoUri);
                    const { uri } = await VideoThumbnails.getThumbnailAsync(resolved, { time: 2000, quality: 0.85 });
                    if (uri) { setThumbnailUri(uri); updateVideo(video.id, { thumbnail: uri }); }
                  } catch (e) {
                    console.warn('[thumbnail] refresh failed:', e);
                  }
                  setGeneratingThumbnail(false);
                }}
                hitSlop={6}
              >
                {generatingThumbnail
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <MaterialIcons name="photo-camera" size={15} color="#fff" />}
              </Pressable>
            </View>
          </View>

          {/* Tabs */}
          <View style={styles.tabBar}>
            {TABS.map(t => (
              <Pressable
                key={t.id}
                style={[styles.tabBtn, tab === t.id && styles.tabBtnActive]}
                onPress={() => setTab(t.id)}
              >
                <Text style={[styles.tabLabel, tab === t.id && styles.tabLabelActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.tabContent}>

            {/* ── Hook Tab ── */}
            {tab === 'hook' ? (
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>Hook Type</Text>
                <View style={styles.hookTypes}>
                  {HOOK_TYPES.map(h => (
                    <Pressable
                      key={h.type}
                      style={[styles.hookTypeCard, hookType === h.type && styles.hookTypeCardActive]}
                      onPress={() => setHookType(h.type)}
                    >
                      <MaterialIcons name={h.icon as any} size={20} color={hookType === h.type ? Colors.primaryLight : Colors.textSecondary} />
                      <Text style={[styles.hookTypeLabel, hookType === h.type && styles.hookTypeLabelActive]}>{h.label}</Text>
                      <Text style={styles.hookTypeDesc}>{h.desc}</Text>
                    </Pressable>
                  ))}
                </View>

                <Pressable
                  style={({ pressed }) => [styles.aiBtn, pressed && { opacity: 0.85 }, generatingHook && styles.aiBtnLoading]}
                  onPress={handleGenerateHook}
                  disabled={generatingHook}
                >
                  {generatingHook ? (
                    <><ActivityIndicator size="small" color={Colors.primaryLight} /><Text style={styles.aiBtnText}>Writing hook...</Text></>
                  ) : (
                    <><MaterialCommunityIcons name="auto-fix" size={16} color={Colors.primaryLight} /><Text style={styles.aiBtnText}>{hookText ? 'Regenerate Hook' : 'AI Generate Hook'}</Text></>
                  )}
                </Pressable>

                <Text style={[styles.sectionLabel, { marginTop: Spacing.xs }]}>Hook Text</Text>
                <TextInput
                  style={styles.textInput}
                  value={hookText}
                  onChangeText={(text) => {
                    setHookText(text);
                    if (hookSaveTimer.current) clearTimeout(hookSaveTimer.current);
                    hookSaveTimer.current = setTimeout(() => {
                      updateVideo(video.id, { hook: { type: hookType, text } });
                    }, 800);
                  }}
                  placeholder="AI will write a viral hook for your video..."
                  placeholderTextColor={Colors.textMuted}
                  multiline
                  numberOfLines={3}
                />
                <Text style={styles.charCount}>{hookText.length}/100</Text>
              </View>
            ) : null}

            {/* ── Caption Tab ── */}
            {tab === 'caption' ? (
              <View style={styles.section}>
                <Pressable
                  style={({ pressed }) => [styles.aiBtn, pressed && { opacity: 0.85 }, generatingCaption && styles.aiBtnLoading]}
                  onPress={handleGenerateCaption}
                  disabled={generatingCaption}
                >
                  {generatingCaption ? (
                    <><ActivityIndicator size="small" color={Colors.primaryLight} /><Text style={styles.aiBtnText}>Writing caption...</Text></>
                  ) : (
                    <><MaterialCommunityIcons name="auto-fix" size={16} color={Colors.primaryLight} /><Text style={styles.aiBtnText}>{caption ? 'Regenerate Caption & Hashtags' : 'AI Write Caption & Hashtags'}</Text></>
                  )}
                </Pressable>

                <Text style={styles.sectionLabel}>Caption</Text>
                <TextInput
                  style={[styles.textInput, { minHeight: 100 }]}
                  value={caption}
                  onChangeText={setCaption}
                  placeholder="AI will write your caption..."
                  placeholderTextColor={Colors.textMuted}
                  multiline
                />
                <Text style={[styles.sectionLabel, { marginTop: Spacing.sm }]}>Hashtags</Text>
                <TextInput
                  style={styles.textInput}
                  value={hashtags}
                  onChangeText={setHashtags}
                  placeholder="#viral #trending #fyp"
                  placeholderTextColor={Colors.textMuted}
                  multiline
                />
                <View style={styles.suggestedTags}>
                  {['#fyp', '#viral', '#trending', '#foryou', '#explore'].map(tag => (
                    <Pressable key={tag} style={styles.tagChip} onPress={() => setHashtags(prev => prev ? `${prev} ${tag}` : tag)}>
                      <Text style={styles.tagChipText}>{tag}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}

            {/* ── Audio Tab ── */}
            {tab === 'audio' ? (
              <View style={styles.section}>
                <Pressable
                  style={({ pressed }) => [styles.aiBtn, pressed && { opacity: 0.85 }, generatingAudio && styles.aiBtnLoading]}
                  onPress={handleGenerateAudio}
                  disabled={generatingAudio}
                >
                  {generatingAudio ? (
                    <><ActivityIndicator size="small" color={Colors.primaryLight} /><Text style={styles.aiBtnText}>Picking best song...</Text></>
                  ) : (
                    <><MaterialCommunityIcons name="auto-fix" size={16} color={Colors.primaryLight} /><Text style={styles.aiBtnText}>{aiPickedSong ? 'Pick a Different Song' : 'AI Pick Best Song'}</Text></>
                  )}
                </Pressable>

                {aiPickedSong ? (
                  <View style={styles.aiPickedCard}>
                    <View style={styles.aiPickedHeader}>
                      <MaterialCommunityIcons name="auto-fix" size={13} color={Colors.primaryLight} />
                      <Text style={styles.aiPickedLabel}>AI Best Pick</Text>
                      <Pressable onPress={() => { setAiPickedSong(null); setSelectedAudioId(video.audio?.id ?? ''); }} hitSlop={8}>
                        <MaterialIcons name="close" size={14} color={Colors.textMuted} />
                      </Pressable>
                    </View>
                    <View style={[styles.audioRow, styles.audioRowActive]}>
                      <View style={[styles.audioIcon, { backgroundColor: Colors.primary }]}>
                        <MaterialIcons name="music-note" size={18} color="#fff" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.audioTitle}>{aiPickedSong.title}</Text>
                        <Text style={styles.audioArtist}>{aiPickedSong.artist}</Text>
                        {aiPickedSong.mood ? <Text style={styles.audioMoodTag}>{aiPickedSong.mood}</Text> : null}
                      </View>
                      <View style={styles.audioMeta}>
                        <View style={styles.trendingBadge}>
                          <MaterialIcons name="trending-up" size={10} color={Colors.primary} />
                          <Text style={styles.trendingText}>Hot</Text>
                        </View>
                        <Text style={styles.audioUses}>{aiPickedSong.uses}</Text>
                      </View>
                      <MaterialIcons name="check-circle" size={20} color={Colors.primary} />
                    </View>
                    {aiPickedSong.reason ? <Text style={styles.aiReasonText}>{aiPickedSong.reason}</Text> : null}
                  </View>
                ) : null}

                {/* Music mixing status pill */}
                {audioStatus !== 'idle' ? (
                  <View style={styles.audioStatusRow}>
                    {audioStatus === 'loading' ? (
                      <><ActivityIndicator size="small" color={Colors.primaryLight} style={{ marginRight: 6 }} /><Text style={styles.audioStatusText}>Fetching preview…</Text></>
                    ) : audioStatus === 'ready' ? (
                      <><MaterialIcons name="music-note" size={14} color={Colors.emerald} /><Text style={[styles.audioStatusText, { color: Colors.emerald }]}>Music ready to mix</Text></>
                    ) : (
                      <><MaterialIcons name="music-off" size={14} color={Colors.amber} /><Text style={[styles.audioStatusText, { color: Colors.amber }]}>Preview unavailable — no music will be mixed</Text></>
                    )}
                  </View>
                ) : null}

                {/* Audio mix volume controls */}
                <View style={styles.mixSection}>
                  <Text style={styles.mixTitle}>Audio Mix</Text>
                  <View style={styles.mixRow}>
                    <MaterialIcons name="record-voice-over" size={16} color={Colors.textSecondary} />
                    <Text style={styles.mixLabel}>Original Voice</Text>
                    <Text style={styles.mixValue}>{Math.round(originalVolume * 100)}%</Text>
                  </View>
                  <Slider
                    style={styles.mixSlider}
                    minimumValue={0}
                    maximumValue={1}
                    step={0.05}
                    value={originalVolume}
                    onValueChange={setOriginalVolume}
                    minimumTrackTintColor={Colors.primary}
                    maximumTrackTintColor={Colors.border}
                    thumbTintColor={Colors.primary}
                  />
                  <View style={styles.mixRow}>
                    <MaterialIcons name="music-note" size={16} color={Colors.primaryLight} />
                    <Text style={styles.mixLabel}>Background Music</Text>
                    <Text style={styles.mixValue}>{Math.round(bgVolume * 100)}%</Text>
                  </View>
                  <Slider
                    style={styles.mixSlider}
                    minimumValue={0}
                    maximumValue={1}
                    step={0.05}
                    value={bgVolume}
                    onValueChange={setBgVolume}
                    minimumTrackTintColor={Colors.primaryLight}
                    maximumTrackTintColor={Colors.border}
                    thumbTintColor={Colors.primaryLight}
                  />
                </View>

                <View style={styles.audioHeader}>
                  <Text style={styles.sectionLabel}>Trending Audio</Text>
                  {aiPickedSong ? <Text style={styles.orPickText}>or pick manually below</Text> : null}
                </View>

                {MOCK_TRENDING_AUDIO.map(audio => {
                  const isSelected = selectedAudioId === audio.id && !aiPickedSong;
                  return (
                    <Pressable
                      key={audio.id}
                      style={[styles.audioRow, isSelected && styles.audioRowActive]}
                      onPress={() => {
                        setSelectedAudioId(audio.id);
                        setAiPickedSong(null);
                        prefetchAudioForSong(audio.id, audio.title, audio.artist);
                      }}
                    >
                      <View style={[styles.audioIcon, isSelected && { backgroundColor: Colors.primary }]}>
                        <MaterialIcons name="music-note" size={18} color={isSelected ? '#fff' : Colors.textSecondary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.audioTitle}>{audio.title}</Text>
                        <Text style={styles.audioArtist}>{audio.artist}</Text>
                      </View>
                      <View style={styles.audioMeta}>
                        {audio.trending ? (
                          <View style={styles.trendingBadge}>
                            <MaterialIcons name="trending-up" size={10} color={Colors.primary} />
                            <Text style={styles.trendingText}>Hot</Text>
                          </View>
                        ) : null}
                        <Text style={styles.audioUses}>{audio.uses}</Text>
                      </View>
                      {isSelected ? <MaterialIcons name="check-circle" size={20} color={Colors.primary} /> : null}
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            {/* ── Platforms Tab ── */}
            {tab === 'platforms' ? (
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>Target Platforms</Text>
                {ALL_PLATFORMS.map(p => (
                  <Pressable
                    key={p}
                    style={[styles.platformRow, platforms.includes(p) && styles.platformRowActive]}
                    onPress={() => togglePlatform(p)}
                  >
                    <PlatformBadge platform={p} size="md" />
                    <Text style={styles.platformLabel}>
                      {p === 'tiktok' ? 'TikTok' : p === 'reels' ? 'Instagram Reels' : 'YouTube Shorts'}
                    </Text>
                    <View style={[styles.checkbox, platforms.includes(p) && styles.checkboxActive]}>
                      {platforms.includes(p) ? <MaterialIcons name="check" size={14} color="#fff" /> : null}
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>

          {/* Actions */}
          <View style={styles.actions}>
            <Pressable style={({ pressed }) => [styles.scheduleBtn, pressed && { opacity: 0.8 }]} onPress={handleSchedule}>
              <MaterialIcons name="schedule" size={18} color={Colors.primaryLight} />
              <Text style={styles.scheduleBtnText}>Schedule</Text>
            </Pressable>
            <Pressable style={({ pressed }) => [styles.publishBtn, pressed && { opacity: 0.8 }]} onPress={handlePublish}>
              <MaterialIcons name="send" size={18} color="#fff" />
              <Text style={styles.publishBtnText}>Publish Now</Text>
            </Pressable>
          </View>

          <View style={{ height: Spacing.xl }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Instagram Publish Sheet ── */}
      <Modal
        visible={showInstagramSheet}
        animationType="slide"
        transparent
        onRequestClose={() => { setShowInstagramSheet(false); instagram.resetPublish(); }}
      >
        <View style={styles.sheetOverlay}>
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={() => {
              if (instagram.publishState.phase === 'idle' && !uploadingToStorage)
                setShowInstagramSheet(false);
            }}
          />
          <View style={styles.tiktokSheet}>
            <View style={styles.sheetHandle} />

            <View style={styles.sheetHeader}>
              <View style={[styles.sheetIcon, { backgroundColor: '#e1306c' }]}>
                <MaterialCommunityIcons name="instagram" size={22} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>Publish to Instagram</Text>
                <Text style={styles.sheetSub}>
                  {instagram.status.username ? `@${instagram.status.username}` : 'your account'}
                </Text>
              </View>
              {instagram.publishState.phase === 'idle' && !uploadingToStorage ? (
                <Pressable onPress={() => setShowInstagramSheet(false)} hitSlop={8}>
                  <MaterialIcons name="close" size={20} color={Colors.textMuted} />
                </Pressable>
              ) : null}
            </View>

            {instagram.publishState.phase === 'idle' && !uploadingToStorage ? (
              <>
                <View style={styles.sheetNote}>
                  <MaterialIcons name="info-outline" size={13} color={Colors.textMuted} />
                  <Text style={styles.sheetNoteText}>
                    The video will be posted as an Instagram Reel. Your caption and hashtags will be included.
                  </Text>
                </View>
                <Pressable
                  style={({ pressed }) => [styles.tiktokPublishBtn, { backgroundColor: '#e1306c' }, pressed && { opacity: 0.85 }]}
                  onPress={handleInstagramPublish}
                >
                  <MaterialCommunityIcons name="instagram" size={18} color="#fff" />
                  <Text style={styles.tiktokPublishBtnText}>Post as Reel</Text>
                </Pressable>
              </>
            ) : null}

            {uploadingToStorage ? (
              <View style={styles.sheetPhase}>
                <ActivityIndicator size="large" color="#e1306c" />
                <Text style={styles.sheetPhaseTitle}>
                  {burningOverlay ? 'Burning hook overlay...' : 'Uploading video...'}
                </Text>
                <Text style={styles.sheetPhaseSub}>
                  {burningOverlay
                    ? (burnAudioLabel ? `🎵 ${burnAudioLabel}` : 'Adding hook text...')
                    : 'Preparing your video for Instagram.'}
                </Text>
                {!burningOverlay && uploadProgress > 0 ? (
                  <View style={styles.progressBarBg}>
                    <View style={[styles.progressBarFill, { width: `${uploadProgress}%` as any, backgroundColor: '#e1306c' }]} />
                  </View>
                ) : null}
              </View>
            ) : null}

            {!uploadingToStorage && (instagram.publishState.phase === 'creating' || instagram.publishState.phase === 'processing' || instagram.publishState.phase === 'publishing') ? (
              <View style={styles.sheetPhase}>
                <ActivityIndicator size="large" color="#e1306c" />
                <Text style={styles.sheetPhaseTitle}>
                  {instagram.publishState.phase === 'creating'
                    ? 'Creating media container...'
                    : instagram.publishState.phase === 'processing'
                    ? 'Instagram is processing the video...'
                    : 'Publishing your Reel...'}
                </Text>
                <Text style={styles.sheetPhaseSub}>
                  {instagram.publishState.phase === 'processing'
                    ? 'This can take up to 2 minutes.'
                    : 'Almost there...'}
                </Text>
              </View>
            ) : null}

            {instagram.publishState.phase === 'success' ? (
              <View style={styles.sheetPhase}>
                <MaterialIcons name="check-circle" size={56} color={Colors.emerald} />
                <Text style={styles.sheetPhaseTitle}>Posted to Instagram!</Text>
                <Text style={styles.sheetPhaseSub}>Your Reel is live. Open Instagram to view it.</Text>
                <Pressable
                  style={[styles.tiktokPublishBtn, { marginTop: Spacing.md, backgroundColor: '#e1306c' }]}
                  onPress={() => {
                    instagram.resetPublish();
                    setShowInstagramSheet(false);
                    updateVideo(video.id, { status: 'published', publishedAt: new Date().toISOString() });
                    router.push('/(tabs)/library');
                  }}
                >
                  <Text style={styles.tiktokPublishBtnText}>Done</Text>
                </Pressable>
              </View>
            ) : null}

            {instagram.publishState.phase === 'error' ? (
              <View style={styles.sheetPhase}>
                <MaterialIcons name="error-outline" size={52} color={Colors.error} />
                <Text style={styles.sheetPhaseTitle}>Publish Failed</Text>
                <Text style={styles.sheetPhaseSub}>{instagram.publishState.errorMessage}</Text>
                <Pressable
                  style={[styles.tiktokPublishBtn, { marginTop: Spacing.md, backgroundColor: Colors.error }]}
                  onPress={() => instagram.resetPublish()}
                >
                  <Text style={styles.tiktokPublishBtnText}>Try Again</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>

      {/* ── TikTok Publish Sheet ── */}
      <Modal
        visible={showTikTokSheet}
        animationType="slide"
        transparent
        onRequestClose={() => { setShowTikTokSheet(false); tiktok.resetPublish(); }}
      >
        <View style={styles.sheetOverlay}>
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={() => { if (tiktok.publishState.phase === 'idle' && !uploadingToStorage) setShowTikTokSheet(false); }}
          />
          <View style={styles.tiktokSheet}>
            <View style={styles.sheetHandle} />

            <View style={styles.sheetHeader}>
              <View style={[styles.sheetIcon, { backgroundColor: '#010101' }]}>
                <MaterialCommunityIcons name="music-note" size={22} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>Publish to TikTok</Text>
                <Text style={styles.sheetSub}>@{tiktok.status.creatorName || 'your account'}</Text>
              </View>
              {tiktok.publishState.phase === 'idle' ? (
                <Pressable onPress={() => setShowTikTokSheet(false)} hitSlop={8}>
                  <MaterialIcons name="close" size={20} color={Colors.textMuted} />
                </Pressable>
              ) : null}
            </View>

            {tiktok.publishState.phase === 'idle' && !uploadingToStorage ? (
              <>
                <Text style={styles.sheetSectionLabel}>Privacy</Text>
                {[
                  { value: 'SELF_ONLY', label: 'Only Me', icon: 'lock' },
                  { value: 'FRIENDS_ONLY', label: 'Friends Only', icon: 'people' },
                  { value: 'PUBLIC_TO_EVERYONE', label: 'Public', icon: 'public' },
                ].map(opt => (
                  <Pressable
                    key={opt.value}
                    style={[styles.privacyRow, tiktokPrivacy === opt.value && styles.privacyRowActive]}
                    onPress={() => setTiktokPrivacy(opt.value)}
                  >
                    <MaterialIcons name={opt.icon as any} size={18} color={tiktokPrivacy === opt.value ? Colors.primaryLight : Colors.textSecondary} />
                    <Text style={[styles.privacyLabel, tiktokPrivacy === opt.value && styles.privacyLabelActive]}>{opt.label}</Text>
                    {tiktokPrivacy === opt.value ? <MaterialIcons name="check-circle" size={18} color={Colors.primary} /> : null}
                  </Pressable>
                ))}
                <View style={styles.sheetNote}>
                  <MaterialIcons name="info-outline" size={13} color={Colors.textMuted} />
                  <Text style={styles.sheetNoteText}>Start with "Only Me" to review before making it public.</Text>
                </View>
                <Pressable style={({ pressed }) => [styles.tiktokPublishBtn, pressed && { opacity: 0.85 }]} onPress={handleTikTokPublish}>
                  <MaterialCommunityIcons name="music-note" size={18} color="#fff" />
                  <Text style={styles.tiktokPublishBtnText}>Post to TikTok</Text>
                </Pressable>
              </>
            ) : null}

            {burningOverlay ? (
              <View style={styles.sheetPhase}>
                <ActivityIndicator size="large" color={Colors.primaryLight} />
                <Text style={styles.sheetPhaseTitle}>Burning hook overlay...</Text>
                <Text style={styles.sheetPhaseSub}>
                  {burnAudioLabel ? `Mixing: ${burnAudioLabel}` : 'Adding hook text (no music)'}
                </Text>
              </View>
            ) : null}

            {uploadingToStorage && !burningOverlay ? (
              <View style={styles.sheetPhase}>
                <ActivityIndicator size="large" color={Colors.primaryLight} />
                <Text style={styles.sheetPhaseTitle}>Uploading video...</Text>
                <Text style={styles.sheetPhaseSub}>Preparing your video for TikTok.</Text>
                {uploadProgress > 0 ? (
                  <View style={styles.progressBarBg}>
                    <View style={[styles.progressBarFill, { width: `${uploadProgress}%` as any }]} />
                  </View>
                ) : null}
              </View>
            ) : null}

            {!uploadingToStorage && (tiktok.publishState.phase === 'uploading' || tiktok.publishState.phase === 'processing') ? (
              <View style={styles.sheetPhase}>
                <ActivityIndicator size="large" color={Colors.primaryLight} />
                <Text style={styles.sheetPhaseTitle}>
                  {tiktok.publishState.phase === 'uploading' ? 'Sending to TikTok...' : 'TikTok is processing your video...'}
                </Text>
                <Text style={styles.sheetPhaseSub}>
                  {tiktok.publishState.phase === 'processing' ? 'This can take up to 2 minutes.' : 'Connecting to TikTok API...'}
                </Text>
              </View>
            ) : null}

            {tiktok.publishState.phase === 'success' ? (
              <View style={styles.sheetPhase}>
                <MaterialIcons name="check-circle" size={56} color={Colors.emerald} />
                <Text style={styles.sheetPhaseTitle}>Posted to TikTok!</Text>
                <Text style={styles.sheetPhaseSub}>Your video is live. Open TikTok to view it.</Text>
                <Pressable
                  style={[styles.tiktokPublishBtn, { marginTop: Spacing.md }]}
                  onPress={() => {
                    tiktok.resetPublish();
                    setShowTikTokSheet(false);
                    updateVideo(video.id, { status: 'published', publishedAt: new Date().toISOString() });
                    router.push('/(tabs)/library');
                  }}
                >
                  <Text style={styles.tiktokPublishBtnText}>Done</Text>
                </Pressable>
              </View>
            ) : null}

            {tiktok.publishState.phase === 'error' ? (
              <View style={styles.sheetPhase}>
                <MaterialIcons name="error-outline" size={52} color={Colors.error} />
                <Text style={styles.sheetPhaseTitle}>Publish Failed</Text>
                <Text style={styles.sheetPhaseSub}>{tiktok.publishState.errorMessage}</Text>
                <Pressable
                  style={[styles.tiktokPublishBtn, { marginTop: Spacing.md, backgroundColor: Colors.error }]}
                  onPress={() => tiktok.resetPublish()}
                >
                  <Text style={styles.tiktokPublishBtnText}>Try Again</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>

      {/* ── Edge Function Test Modal ── */}
      <Modal
        visible={showTestModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowTestModal(false)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setShowTestModal(false)} />
          <View style={[styles.tiktokSheet, { maxHeight: '90%' }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View style={[styles.sheetIcon, { backgroundColor: Colors.amber + '22' }]}>
                <MaterialIcons name="bug-report" size={22} color={Colors.amber} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>Edge Function Tests</Text>
                <Text style={styles.sheetSub}>Verify each function is deployed and reachable</Text>
              </View>
              <Pressable onPress={() => setShowTestModal(false)} hitSlop={8}>
                <MaterialIcons name="close" size={20} color={Colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
              {([
                { key: 'audio-pipeline' as TestKey, label: 'Audio Pipeline', desc: 'iTunes search → download → show file size', icon: 'music-circle', color: Colors.amber },
                { key: 'ai-content-generator' as TestKey, label: 'AI Content Generator', desc: 'Sends a test hook request (type=hook)', icon: 'auto-fix', color: Colors.primaryLight },
                { key: 'wayinvideo-analyzer' as TestKey, label: 'WayinVideo Analyzer', desc: 'Sends a ping/action=ping request', icon: 'movie-filter', color: Colors.emerald },
                { key: 'tiktok-publisher' as TestKey, label: 'TikTok Publisher', desc: 'Sends a status check request', icon: 'music-note', color: '#ee1d52' },
              ]).map(fn => (
                <View key={fn.key} style={styles.testCard}>
                  <View style={styles.testCardHeader}>
                    <View style={[styles.testCardIcon, { backgroundColor: fn.color + '22' }]}>
                      <MaterialCommunityIcons name={fn.icon as any} size={18} color={fn.color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.testCardLabel}>{fn.label}</Text>
                      <Text style={styles.testCardDesc}>{fn.desc}</Text>
                    </View>
                    <Pressable
                      style={({ pressed }) => [styles.testRunBtn, { borderColor: fn.color + '88', backgroundColor: fn.color + '18' }, pressed && { opacity: 0.75 }, testLoading[fn.key] && { opacity: 0.5 }]}
                      onPress={() => runFunctionTest(fn.key)}
                      disabled={testLoading[fn.key]}
                    >
                      {testLoading[fn.key]
                        ? <ActivityIndicator size="small" color={fn.color} />
                        : <Text style={[styles.testRunBtnText, { color: fn.color }]}>Run</Text>}
                    </Pressable>
                  </View>
                  {testResults[fn.key] ? (
                    <View style={[styles.testResultBox, testResults[fn.key]?.startsWith('ERROR') || testResults[fn.key]?.startsWith('EXCEPTION') ? styles.testResultBoxError : styles.testResultBoxOk]}>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <Text style={styles.testResultText} selectable>{testResults[fn.key]}</Text>
                      </ScrollView>
                    </View>
                  ) : null}
                </View>
              ))}
              <View style={{ height: 20 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── Video Player Modal ── */}
      <Modal
        visible={showPlayer}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => { videoPlayer?.pause(); setShowPlayer(false); }}
      >
        <View style={styles.playerModal}>
          <Pressable
            style={styles.playerClose}
            onPress={() => { videoPlayer?.pause(); setShowPlayer(false); }}
            hitSlop={8}
          >
            <MaterialIcons name="close" size={26} color="#fff" />
          </Pressable>
          <Text style={styles.playerTitle} numberOfLines={2}>{video.title}</Text>

          {video.videoUri ? (
            <View style={{ flex: 1, justifyContent: 'center' }}>
              <VideoView player={videoPlayer} style={styles.videoView} contentFit="contain" nativeControls />
              {hookText ? (
                <View style={styles.playerHookOverlay} pointerEvents="none">
                  <Text style={styles.playerHookText}>{hookText}</Text>
                </View>
              ) : null}
            </View>
          ) : (
            <View style={styles.noVideoContainer}>
              <Image source={{ uri: video.thumbnail }} style={styles.noVideoThumb} contentFit="cover" transition={200} />
              <View style={styles.noVideoOverlay}>
                <MaterialCommunityIcons name="video-off-outline" size={44} color="rgba(255,255,255,0.7)" />
                <Text style={styles.noVideoText}>No video file attached</Text>
                <Text style={styles.noVideoSub}>Upload a video from your device to preview it here</Text>
              </View>
            </View>
          )}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm + 4,
    borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: Radius.full,
    backgroundColor: Colors.surfaceElevated, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  headerTitle: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: Colors.textPrimary, includeFontPadding: false },
  headerMeta: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: 4 },
  duration: { fontSize: FontSize.xs, color: Colors.textMuted, includeFontPadding: false },
  saveBtn: {
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.full,
    paddingHorizontal: 14, paddingVertical: 7, borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  saveBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary, includeFontPadding: false },
  titleRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.sm,
  },
  titleInput: {
    flex: 1, backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    paddingHorizontal: Spacing.sm + 4, paddingVertical: 10,
    fontSize: FontSize.md, fontWeight: FontWeight.semibold,
    color: Colors.textPrimary, includeFontPadding: false,
  },
  titleAiBtn: {
    width: 42, height: 42, borderRadius: Radius.full,
    backgroundColor: Colors.primaryGlow, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: Colors.primary,
  },
  previewContainer: { alignItems: 'center', paddingVertical: Spacing.md },
  preview: {
    width: 140, height: 200, borderRadius: Radius.lg,
    overflow: 'hidden', position: 'relative', backgroundColor: Colors.surface,
  },
  previewImg: { width: '100%', height: '100%' },
  hookOverlay: {
    position: 'absolute', bottom: 16, left: 8, right: 8,
    backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: Radius.sm, padding: 6,
  },
  hookOverlayText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: '#fff', textAlign: 'center', includeFontPadding: false },
  playBtn: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  thumbRefreshBtn: {
    position: 'absolute', bottom: 6, right: 6,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: Radius.full,
    width: 28, height: 28, alignItems: 'center', justifyContent: 'center',
  },
  tabBar: {
    flexDirection: 'row', marginHorizontal: Spacing.md,
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.full,
    padding: 4, borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  tabBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: Radius.full },
  tabBtnActive: { backgroundColor: Colors.primary },
  tabLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textSecondary, includeFontPadding: false },
  tabLabelActive: { color: '#fff' },
  tabContent: { paddingTop: Spacing.md },
  section: { paddingHorizontal: Spacing.md, gap: Spacing.sm },
  sectionLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textSecondary, includeFontPadding: false },
  aiBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.primaryGlow, borderRadius: Radius.full, paddingVertical: 13,
    borderWidth: 1.5, borderColor: Colors.primary, minHeight: 48,
  },
  aiBtnLoading: { opacity: 0.7 },
  aiBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.primaryLight, includeFontPadding: false },
  aiPickedCard: {
    backgroundColor: Colors.primaryGlow, borderRadius: Radius.lg, padding: Spacing.sm,
    borderWidth: 1, borderColor: Colors.primary + '55', gap: Spacing.xs,
  },
  aiPickedHeader: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 },
  aiPickedLabel: {
    flex: 1, fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.primaryLight,
    textTransform: 'uppercase', letterSpacing: 0.8, includeFontPadding: false,
  },
  aiReasonText: { fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16, fontStyle: 'italic', marginTop: 2, includeFontPadding: false },
  orPickText: { fontSize: FontSize.xs, color: Colors.textMuted, fontWeight: FontWeight.medium, includeFontPadding: false },
  audioStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.surfaceBorder },
  audioStatusText: { fontSize: FontSize.xs, color: Colors.textSecondary, includeFontPadding: false },
  mixSection: { backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.surfaceBorder, padding: Spacing.sm, gap: 4 },
  mixTitle: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  mixRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mixLabel: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary },
  mixValue: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textPrimary, minWidth: 36, textAlign: 'right' },
  mixSlider: { width: '100%', height: 32 },
  hookTypes: { flexDirection: 'row', gap: Spacing.sm },
  hookTypeCard: {
    flex: 1, backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md,
    padding: Spacing.sm, alignItems: 'center', gap: 4, borderWidth: 1.5, borderColor: Colors.surfaceBorder,
  },
  hookTypeCardActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryGlow },
  hookTypeLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textSecondary, includeFontPadding: false },
  hookTypeLabelActive: { color: Colors.primaryLight },
  hookTypeDesc: { fontSize: 10, color: Colors.textMuted, textAlign: 'center', includeFontPadding: false },
  textInput: {
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md, borderWidth: 1,
    borderColor: Colors.surfaceBorder, padding: Spacing.sm + 4, fontSize: FontSize.md,
    color: Colors.textPrimary, textAlignVertical: 'top', minHeight: 80, includeFontPadding: false,
  },
  charCount: { fontSize: FontSize.xs, color: Colors.textMuted, textAlign: 'right', includeFontPadding: false },
  suggestedTags: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: 4 },
  tagChip: {
    backgroundColor: Colors.primaryGlow, borderRadius: Radius.full,
    paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: Colors.primary + '44',
  },
  tagChipText: { fontSize: FontSize.sm, color: Colors.primaryLight, fontWeight: FontWeight.semibold, includeFontPadding: false },
  audioHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  audioRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md,
    padding: Spacing.sm + 4, borderWidth: 1.5, borderColor: Colors.surfaceBorder,
  },
  audioRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryGlow },
  audioIcon: {
    width: 36, height: 36, borderRadius: Radius.full,
    backgroundColor: Colors.surfaceBorder, alignItems: 'center', justifyContent: 'center',
  },
  audioTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary, includeFontPadding: false },
  audioArtist: { fontSize: FontSize.xs, color: Colors.textSecondary, includeFontPadding: false },
  audioMoodTag: { fontSize: 10, color: Colors.primaryLight, fontWeight: FontWeight.medium, marginTop: 2, includeFontPadding: false, textTransform: 'capitalize' },
  audioMeta: { alignItems: 'flex-end', gap: 3 },
  trendingBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    backgroundColor: Colors.primaryGlow, borderRadius: Radius.full,
    paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: Colors.primary + '33',
  },
  trendingText: { fontSize: 9, color: Colors.primary, fontWeight: FontWeight.bold, includeFontPadding: false },
  audioUses: { fontSize: FontSize.xs, color: Colors.textMuted, includeFontPadding: false },
  platformRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md,
    padding: Spacing.sm + 4, borderWidth: 1.5, borderColor: Colors.surfaceBorder,
  },
  platformRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryGlow },
  platformLabel: { flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.semibold, color: Colors.textPrimary, includeFontPadding: false },
  checkbox: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 2,
    borderColor: Colors.textMuted, alignItems: 'center', justifyContent: 'center',
  },
  checkboxActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  actions: {
    flexDirection: 'row', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md,
  },
  scheduleBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: Colors.primaryGlow, borderRadius: Radius.full, paddingVertical: 14,
    borderWidth: 1.5, borderColor: Colors.primary,
  },
  scheduleBtnText: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: Colors.primaryLight, includeFontPadding: false },
  publishBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: Colors.primary, borderRadius: Radius.full, paddingVertical: 14,
  },
  publishBtnText: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, includeFontPadding: false },
  uploadBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.full,
    paddingHorizontal: 24, paddingVertical: 12,
  },
  uploadBtnText: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },

  // Sheets
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  tiktokSheet: {
    backgroundColor: Colors.surfaceElevated, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: Spacing.md, paddingBottom: 36, gap: Spacing.sm,
  },
  sheetHandle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.surfaceBorder,
    alignSelf: 'center', marginTop: 12, marginBottom: 4,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.sm },
  sheetIcon: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
  },
  sheetTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, includeFontPadding: false },
  sheetSub: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
  sheetSectionLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.textMuted, textTransform: 'uppercase', letterSpacing: 1, includeFontPadding: false, marginTop: Spacing.xs },
  sheetNote: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sheetNoteText: { flex: 1, fontSize: FontSize.xs, color: Colors.textMuted, includeFontPadding: false },
  sheetPhase: { alignItems: 'center', paddingVertical: Spacing.xl, gap: Spacing.sm },
  sheetPhaseTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, includeFontPadding: false },
  sheetPhaseSub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', includeFontPadding: false },
  privacyRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderRadius: Radius.md,
    padding: Spacing.sm + 4, borderWidth: 1.5, borderColor: Colors.surfaceBorder,
  },
  privacyRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryGlow },
  privacyLabel: { flex: 1, fontSize: FontSize.md, color: Colors.textSecondary, includeFontPadding: false },
  privacyLabelActive: { color: Colors.primaryLight, fontWeight: FontWeight.semibold },
  tiktokPublishBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.primary, borderRadius: Radius.full, paddingVertical: 14,
    marginTop: Spacing.sm,
  },
  tiktokPublishBtnText: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  progressBarBg: {
    width: '100%', height: 6, backgroundColor: Colors.surfaceBorder,
    borderRadius: 3, overflow: 'hidden', marginTop: Spacing.sm,
  },
  progressBarFill: { height: '100%', backgroundColor: Colors.primary, borderRadius: 3 },
  testIconBtn: {
    width: 36, height: 36, borderRadius: Radius.full,
    backgroundColor: Colors.amber + '1A', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.amber + '44',
  },
  testCard: {
    backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.sm + 4,
    borderWidth: 1, borderColor: Colors.surfaceBorder, marginBottom: Spacing.sm, gap: Spacing.sm,
  },
  testCardHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  testCardIcon: {
    width: 36, height: 36, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center',
  },
  testCardLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textPrimary, includeFontPadding: false },
  testCardDesc: { fontSize: FontSize.xs, color: Colors.textMuted, includeFontPadding: false, marginTop: 1 },
  testRunBtn: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: Radius.full,
    borderWidth: 1.5, minWidth: 52, alignItems: 'center', justifyContent: 'center',
  },
  testRunBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, includeFontPadding: false },
  testResultBox: {
    borderRadius: Radius.md, padding: Spacing.sm, maxHeight: 140,
    borderWidth: 1, overflow: 'hidden',
  },
  testResultBoxOk: { backgroundColor: Colors.emerald + '11', borderColor: Colors.emerald + '44' },
  testResultBoxError: { backgroundColor: Colors.error + '11', borderColor: Colors.error + '44' },
  testResultText: { fontSize: 11, color: Colors.textSecondary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', includeFontPadding: false },

  // Player
  playerModal: { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
  playerClose: { position: 'absolute', top: 52, right: 16, zIndex: 10, padding: 8 },
  playerTitle: {
    position: 'absolute', top: 52, left: 16, right: 60, zIndex: 10,
    color: '#fff', fontSize: FontSize.md, fontWeight: FontWeight.bold, includeFontPadding: false,
  },
  videoView: { width: '100%', height: '100%' },
  playerHookOverlay: {
    position: 'absolute', top: '8%', left: 16, right: 16,
    alignItems: 'center', pointerEvents: 'none',
  },
  playerHookText: {
    color: '#fff', fontSize: 22, fontWeight: '800', textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.35)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
    overflow: 'hidden',
  },
  noVideoContainer: { flex: 1, position: 'relative' },
  noVideoThumb: { width: '100%', height: '100%' },
  noVideoOverlay: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  noVideoText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  noVideoSub: { fontSize: FontSize.sm, color: 'rgba(255,255,255,0.7)', textAlign: 'center', paddingHorizontal: 32, includeFontPadding: false },
});
