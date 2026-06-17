
import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator, Modal, Linking,
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
import { burnHookOverlay, shareToInstagramReels } from '@/services/videoOverlayService';
import { INSTAGRAM_APP_ID } from '@/constants/instagram';
import { searchViralAudio, AudioSearchResult } from '@/services/audioSearchService';
import * as FileSystem from 'expo-file-system';
import * as Clipboard from 'expo-clipboard';
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
  previewUrl?: string;
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
  const [hookVariations, setHookVariations] = useState<string[]>([]);
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
  const [audioQuery, setAudioQuery] = useState('');
  const [searchingAudio, setSearchingAudio] = useState(false);
  const [searchResults, setSearchResults] = useState<AudioSearchResult[]>([]);
  const [previewCache, setPreviewCache] = useState<Record<string, string>>({});
  const [originalVolume, setOriginalVolume] = useState(0.6);
  const [bgVolume, setBgVolume] = useState(0.8);

  const resolveAudioSource = (id: string) =>
    aiPickedSong?.id === id
      ? aiPickedSong
      : searchResults.find(r => r.id === id) ?? MOCK_TRENDING_AUDIO.find(a => a.id === id);

  const [showPlayer, setShowPlayer] = useState(false);
  const [videoTitle, setVideoTitle] = useState('');
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const [showTikTokSheet, setShowTikTokSheet] = useState(false);
  const [showInstagramSheet, setShowInstagramSheet] = useState(false);
  const [tiktokPrivacy, setTiktokPrivacy] = useState('SELF_ONLY');
  const [uploadingToStorage, setUploadingToStorage] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [burningOverlay, setBurningOverlay] = useState(false);
  const [savingToPhotos, setSavingToPhotos] = useState(false);
  const [generatingThumbnail, setGeneratingThumbnail] = useState(false);
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(video?.thumbnail ?? null);

  // ── Edge Function Test Panel ──
  const [showTestModal, setShowTestModal] = useState(false);
  type TestKey = 'ai-content-generator' | 'wayinvideo-analyzer' | 'tiktok-publisher';
  const [testLoading, setTestLoading] = useState<Record<TestKey, boolean>>({
    'ai-content-generator': false,
    'wayinvideo-analyzer': false,
    'tiktok-publisher': false,
  });
  const [testResults, setTestResults] = useState<Record<TestKey, string | null>>({
    'ai-content-generator': null,
    'wayinvideo-analyzer': null,
    'tiktok-publisher': null,
  });

  const runFunctionTest = async (fn: TestKey) => {
    setTestLoading(prev => ({ ...prev, [fn]: true }));
    setTestResults(prev => ({ ...prev, [fn]: null }));
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
    if (video.audio?.id && video.audio.previewUrl) {
      setPreviewCache(prev => ({ ...prev, [video.audio!.id]: video.audio!.previewUrl! }));
    }
    setPlatforms(video.platforms ?? ['tiktok']);
    setThumbnailUri(video.thumbnail ?? null);
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
        const { data, error } = await callAIGenerator('hook', {
          videoTitle: cleanTitle(video.title), hookType: 'question',
          platforms: video.platforms ?? ['tiktok'], ...framePayload,
        });
        if (error) console.warn('[autoGenHook] failed:', error);
        if (data?.result?.length) {
          const variations: string[] = data.result;
          const best = variations[0] ?? '';
          setHookVariations(variations);
          setHookText(best);
          updateVideo(video.id, { hook: { type: 'question', text: best } });
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
        }
      }
    };

    runAll();
  }, [video?.id]);

  // Best-effort: resolve a real ~30s preview clip for whichever song is
  // currently selected (AI pick or trending list), so the volume mixer
  // below has actual audio to mix instead of just a title/artist label.
  useEffect(() => {
    if (!selectedAudioId || previewCache[selectedAudioId]) return;
    const source = resolveAudioSource(selectedAudioId);
    if (!source) return;
    let cancelled = false;
    (async () => {
      const { results } = await searchViralAudio(`${source.title} ${source.artist}`);
      if (!cancelled && results[0]?.previewUrl) {
        setPreviewCache(prev => ({ ...prev, [selectedAudioId]: results[0].previewUrl! }));
      }
    })();
    return () => { cancelled = true; };
  }, [selectedAudioId, aiPickedSong?.id]);

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

  // The background-audio `useEffect` resolves the preview clip lazily and may
  // not have finished by the time the user taps a burn/share action — so the
  // burn step can't just read `previewCache` synchronously, it has to await
  // the same lookup itself or the selected song silently gets dropped.
  const ensureAudioPreviewUrl = async (): Promise<string | undefined> => {
    if (!selectedAudioId) return undefined;
    if (previewCache[selectedAudioId]) return previewCache[selectedAudioId];
    const source = resolveAudioSource(selectedAudioId);
    if (!source) return undefined;

    // The AI's "best song" pick is a free-text guess, not a verified catalog
    // entry — an exact "title artist" search often misses, so fall back to
    // looser queries before giving up on finding a real preview clip.
    const queries = [`${source.title} ${source.artist}`, source.title, source.artist].filter(Boolean);
    for (const q of queries) {
      const { results } = await searchViralAudio(q);
      const previewUrl = results.find(r => r.previewUrl)?.previewUrl;
      if (previewUrl) {
        setPreviewCache(prev => ({ ...prev, [selectedAudioId]: previewUrl }));
        return previewUrl;
      }
    }
    return undefined;
  };

  const handleGenerateHook = async () => {
    setGeneratingHook(true);
    const framePayload = await ensureFrame();
    const { data, error } = await callAIGenerator('hook', {
      videoTitle: cleanTitle(video.title), hookType, platforms, ...framePayload,
    });
    setGeneratingHook(false);
    if (error) { showAlert('AI Error', error); return; }
    if (data?.result?.length) {
      const variations: string[] = data.result;
      const best = variations[0] ?? '';
      setHookVariations(variations);
      setHookText(best);
      updateVideo(video.id, { hook: { type: hookType, text: best } });
    } else {
      showAlert('AI Error', "Couldn't write a hook this time — try again.");
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
    if (song?.id) { setAiPickedSong(song); setSelectedAudioId(song.id); }
  }, [video.title, platforms, showAlert]);

  const handleSearchAudio = async () => {
    if (!audioQuery.trim()) return;
    setSearchingAudio(true);
    const { results, error } = await searchViralAudio(audioQuery.trim());
    setSearchingAudio(false);
    if (error) { showAlert('Search Error', error); return; }
    setSearchResults(results);
  };

  const selectSearchResult = (r: AudioSearchResult) => {
    setSelectedAudioId(r.id);
    setAiPickedSong(null);
    if (r.previewUrl) setPreviewCache(prev => ({ ...prev, [r.id]: r.previewUrl! }));
  };

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
    const audioSource = resolveAudioSource(selectedAudioId);
    return {
      hook: { type: hookType, text: hookText },
      caption,
      hashtags: hashtags.split(/\s+/).filter(Boolean),
      platforms,
      audio: audioSource
        ? {
            id: audioSource.id, title: audioSource.title, artist: audioSource.artist,
            uses: 'uses' in audioSource ? audioSource.uses : '', trending: 'trending' in audioSource ? audioSource.trending : false,
            previewUrl: previewCache[audioSource.id],
          }
        : undefined,
    };
  };

  const handleSave = () => {
    const snap = snapshotEditorState();
    updateVideo(video.id, { ...snap, title: videoTitle });
    router.push('/(tabs)/library');
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

  const burnOverlayLocally = async (
    videoUri: string,
    hookText: string,
  ): Promise<{ outputUri: string; audioMixed: boolean }> => {
    const resolved = await resolveVideoUri(videoUri);

    setBurningOverlay(true);

    let bgLocalPath: string | undefined;
    const previewUrl = await ensureAudioPreviewUrl();
    if (previewUrl) {
      try {
        const dest = FileSystem.cacheDirectory + `bg_audio_${Date.now()}.m4a`;
        const downloadTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('bg audio download timeout')), 10000),
        );
        const dl = await Promise.race([FileSystem.downloadAsync(previewUrl, dest), downloadTimeout]);
        bgLocalPath = dl.uri;
      } catch (e) {
        console.warn('[burnOverlayLocally] bg audio download failed or timed out, continuing without it:', e);
      }
    }

    const { outputUri } = await burnHookOverlay(resolved, hookText, bgLocalPath, originalVolume, bgVolume);
    setBurningOverlay(false);
    return { outputUri, audioMixed: !!bgLocalPath };
  };

  const prepareVideoForPublish = async (
    videoUri: string,
    hookText: string,
  ): Promise<{ videoUrl: string; error?: string }> => {
    if (!user?.id || !video?.id) return { videoUrl: '', error: 'Not authenticated.' };

    const { outputUri } = await burnOverlayLocally(videoUri, hookText);

    setUploadingToStorage(true);
    const { publicUrl, error } = await uploadVideoToStorage(
      outputUri, user.id, video.id, setUploadProgress,
    );
    setUploadingToStorage(false);
    setUploadProgress(0);

    if (error || !publicUrl) return { videoUrl: '', error: error ?? 'Upload failed.' };
    return { videoUrl: publicUrl };
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

    const captionText = [snap.hook?.text, snap.caption, snap.hashtags.join(' ')].filter(Boolean).join('\n\n');
    const audioName = snap.audio ? `${snap.audio.title} by ${snap.audio.artist}` : undefined;
    updateVideo(video.id, { ...snap, title: videoTitle });
    const { error } = await instagram.publish(videoUrl, captionText, undefined, audioName);
    if (error) showAlert('Instagram Error', error);
  };

  const handleOpenInInstagram = async () => {
    const snap = snapshotEditorState();
    if (!video?.videoUri) { showAlert('No Video File', 'Select a video first.'); return; }

    const { outputUri, audioMixed } = await burnOverlayLocally(video.videoUri, snap.hook?.text ?? '');
    updateVideo(video.id, { ...snap, title: videoTitle });

    // Instagram's Reels sharing-to-stories pasteboard handoff has no field
    // for a pre-filled caption (Meta blocks this on purpose to stop spam),
    // so the closest we can do is put it on the clipboard for a quick paste.
    const captionText = [snap.hook?.text, snap.caption, snap.hashtags.join(' ')].filter(Boolean).join('\n\n');
    if (captionText) {
      await Clipboard.setStringAsync(captionText);
    }

    // Meta's documented Sharing-to-Reels handoff: the video goes on the
    // pasteboard (not the Photos library), then instagram-reels://share
    // opens Instagram straight into the Reels composer with it loaded.
    setSavingToPhotos(true);
    const { error: shareError } = await shareToInstagramReels(outputUri, INSTAGRAM_APP_ID);
    setSavingToPhotos(false);
    if (shareError) {
      showAlert('Could Not Open Instagram', shareError);
      return;
    }
    setShowInstagramSheet(false);

    const openInstagram = async () => {
      const opened = await Linking.openURL('instagram-reels://share').then(() => true).catch(() => false);
      if (!opened) {
        showAlert('Instagram Not Installed', 'Please install Instagram to use this feature.');
      }
    };

    // Show this BEFORE switching to Instagram — once the app backgrounds,
    // an alert fired after the fact is easy to miss entirely.
    const notes: string[] = [];
    if (captionText) {
      notes.push("Instagram doesn't let apps pre-fill the caption on Reels drafts, so we copied your caption and hashtags to the clipboard — paste them into the caption field once Instagram opens.");
    }
    if (snap.audio && !audioMixed) {
      notes.push(`We couldn't find a matching preview clip for "${snap.audio.title}", so the original clip audio was kept instead of that song.`);
    }

    if (notes.length) {
      showAlert('Before You Continue', notes.join('\n\n'), [{ text: 'Open Instagram', onPress: openInstagram }]);
    } else {
      await openInstagram();
    }
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

                {hookVariations.length > 1 ? (
                  <View style={{ marginBottom: Spacing.sm }}>
                    <Text style={[styles.sectionLabel, { marginTop: Spacing.xs }]}>Pick a hook</Text>
                    {hookVariations.map((v, i) => (
                      <Pressable
                        key={i}
                        style={[styles.hookVariationCard, hookText === v && styles.hookVariationCardActive]}
                        onPress={() => {
                          setHookText(v);
                          updateVideo(video.id, { hook: { type: hookType, text: v } });
                        }}
                      >
                        <Text style={[styles.hookVariationText, hookText === v && styles.hookVariationTextActive]}>{v}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}

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
                <View style={styles.searchRow}>
                  <View style={styles.searchInputWrap}>
                    <MaterialIcons name="search" size={18} color={Colors.textMuted} />
                    <TextInput
                      style={styles.searchInput}
                      value={audioQuery}
                      onChangeText={setAudioQuery}
                      onSubmitEditing={handleSearchAudio}
                      placeholder="Search any viral song or artist..."
                      placeholderTextColor={Colors.textMuted}
                      returnKeyType="search"
                    />
                  </View>
                  <Pressable
                    style={({ pressed }) => [styles.searchBtn, pressed && { opacity: 0.85 }]}
                    onPress={handleSearchAudio}
                    disabled={searchingAudio}
                  >
                    {searchingAudio ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <MaterialIcons name="search" size={18} color="#fff" />
                    )}
                  </Pressable>
                </View>

                {searchResults.length > 0 ? (
                  <View style={{ gap: Spacing.sm }}>
                    <View style={styles.audioHeader}>
                      <Text style={styles.sectionLabel}>Search Results</Text>
                      <Pressable onPress={() => setSearchResults([])}>
                        <Text style={styles.orPickText}>Clear</Text>
                      </Pressable>
                    </View>
                    {searchResults.map(r => {
                      const isSelected = selectedAudioId === r.id;
                      return (
                        <Pressable
                          key={r.id}
                          style={[styles.audioRow, isSelected && styles.audioRowActive]}
                          onPress={() => selectSearchResult(r)}
                        >
                          {r.artworkUrl ? (
                            <Image source={{ uri: r.artworkUrl }} style={styles.audioArtwork} />
                          ) : (
                            <View style={[styles.audioIcon, isSelected && { backgroundColor: Colors.primary }]}>
                              <MaterialIcons name="music-note" size={18} color={isSelected ? '#fff' : Colors.textSecondary} />
                            </View>
                          )}
                          <View style={{ flex: 1 }}>
                            <Text style={styles.audioTitle}>{r.title}</Text>
                            <Text style={styles.audioArtist}>{r.artist}</Text>
                          </View>
                          {isSelected ? <MaterialIcons name="check-circle" size={20} color={Colors.primary} /> : null}
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}

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
                      onPress={() => { setSelectedAudioId(audio.id); setAiPickedSong(null); }}
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

                {selectedAudioId ? (
                  <View style={styles.volumeSection}>
                    <Text style={styles.sectionLabel}>Audio Mix</Text>
                    <View style={styles.volumeRow}>
                      <Text style={styles.volumeLabel}>Your Video Audio</Text>
                      <Text style={styles.volumeValue}>{Math.round(originalVolume * 100)}%</Text>
                    </View>
                    <Slider
                      style={styles.slider}
                      minimumValue={0}
                      maximumValue={1}
                      value={originalVolume}
                      onValueChange={setOriginalVolume}
                      minimumTrackTintColor={Colors.primary}
                      maximumTrackTintColor={Colors.surfaceBorder}
                      thumbTintColor={Colors.primary}
                    />
                    <View style={styles.volumeRow}>
                      <Text style={styles.volumeLabel}>Background Song</Text>
                      <Text style={styles.volumeValue}>{Math.round(bgVolume * 100)}%</Text>
                    </View>
                    <Slider
                      style={styles.slider}
                      minimumValue={0}
                      maximumValue={1}
                      value={bgVolume}
                      onValueChange={setBgVolume}
                      minimumTrackTintColor={Colors.primary}
                      maximumTrackTintColor={Colors.surfaceBorder}
                      thumbTintColor={Colors.primary}
                    />
                    <Text style={styles.volumeHint}>
                      {previewCache[selectedAudioId]
                        ? 'A short preview clip of this song will be mixed in at these levels.'
                        : 'Looking for a real preview clip to mix in...'}
                    </Text>
                  </View>
                ) : null}
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
          </View>

          {/* Platform Publish Buttons */}
          <View style={styles.publishSection}>
            <Text style={styles.publishSectionLabel}>Publish to</Text>
            <Pressable
              style={({ pressed }) => [
                styles.platformPublishBtn,
                { borderColor: '#010101', backgroundColor: tiktok.status.connected ? '#010101' : Colors.surfaceElevated },
                pressed && { opacity: 0.8 },
                !tiktok.status.connected && styles.platformPublishBtnDisabled,
              ]}
              onPress={() => tiktok.status.connected ? setShowTikTokSheet(true) : showAlert('TikTok Not Connected', 'Connect your TikTok account in Settings to publish here.')}
            >
              <MaterialCommunityIcons name="music-note" size={20} color={tiktok.status.connected ? '#fff' : Colors.textMuted} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.platformPublishName, { color: tiktok.status.connected ? '#fff' : Colors.textMuted }]}>TikTok</Text>
                <Text style={[styles.platformPublishSub, { color: tiktok.status.connected ? 'rgba(255,255,255,0.6)' : Colors.textMuted }]}>
                  {tiktok.status.connected ? `@${tiktok.status.creatorName || 'your account'}` : 'Not connected'}
                </Text>
              </View>
              <MaterialIcons name={tiktok.status.connected ? 'arrow-forward-ios' : 'lock-outline'} size={16} color={tiktok.status.connected ? 'rgba(255,255,255,0.6)' : Colors.textMuted} />
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.platformPublishBtn,
                { borderColor: '#e1306c', backgroundColor: instagram.status.connected ? '#e1306c' : Colors.surfaceElevated },
                pressed && { opacity: 0.8 },
                !instagram.status.connected && styles.platformPublishBtnDisabled,
              ]}
              onPress={() => instagram.status.connected ? setShowInstagramSheet(true) : showAlert('Instagram Not Connected', 'Connect your Instagram account in Settings to publish here.')}
            >
              <MaterialCommunityIcons name="instagram" size={20} color={instagram.status.connected ? '#fff' : Colors.textMuted} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.platformPublishName, { color: instagram.status.connected ? '#fff' : Colors.textMuted }]}>Instagram Reels</Text>
                <Text style={[styles.platformPublishSub, { color: instagram.status.connected ? 'rgba(255,255,255,0.6)' : Colors.textMuted }]}>
                  {instagram.status.connected ? `@${instagram.status.username || 'your account'}` : 'Not connected'}
                </Text>
              </View>
              <MaterialIcons name={instagram.status.connected ? 'arrow-forward-ios' : 'lock-outline'} size={16} color={instagram.status.connected ? 'rgba(255,255,255,0.6)' : Colors.textMuted} />
            </Pressable>

            <Pressable
              style={({ pressed }) => [styles.platformPublishBtn, styles.platformPublishBtnDisabled, pressed && { opacity: 0.8 }]}
              onPress={() => showAlert('YouTube Shorts', 'YouTube Shorts publishing is coming soon!')}
            >
              <MaterialCommunityIcons name="youtube" size={20} color={Colors.textMuted} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.platformPublishName, { color: Colors.textMuted }]}>YouTube Shorts</Text>
                <Text style={[styles.platformPublishSub, { color: Colors.textMuted }]}>Coming soon</Text>
              </View>
              <MaterialIcons name="lock-outline" size={16} color={Colors.textMuted} />
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

            {instagram.publishState.phase === 'idle' && !uploadingToStorage && !burningOverlay && !savingToPhotos ? (
              <>
                <View style={styles.sheetNote}>
                  <MaterialIcons name="info-outline" size={13} color={Colors.textMuted} />
                  <Text style={styles.sheetNoteText}>
                    Hands your hook-burned video straight to Instagram's Reels composer — full editing tools, music, and better engagement than the API publish.
                  </Text>
                </View>
                <Pressable
                  style={({ pressed }) => [styles.tiktokPublishBtn, { backgroundColor: '#e1306c' }, pressed && { opacity: 0.85 }]}
                  onPress={handleOpenInInstagram}
                >
                  <MaterialCommunityIcons name="instagram" size={18} color="#fff" />
                  <Text style={styles.tiktokPublishBtnText}>Finish in Instagram</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.tiktokPublishBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#e1306c', marginTop: Spacing.sm }, pressed && { opacity: 0.7 }]}
                  onPress={handleInstagramPublish}
                >
                  <Text style={[styles.tiktokPublishBtnText, { color: '#e1306c' }]}>Post directly via API</Text>
                </Pressable>
              </>
            ) : null}

            {(burningOverlay || savingToPhotos) ? (
              <View style={styles.sheetPhase}>
                <ActivityIndicator size="large" color="#e1306c" />
                <Text style={styles.sheetPhaseTitle}>
                  {burningOverlay ? 'Applying hook & audio...' : 'Handing off to Instagram...'}
                </Text>
                <Text style={styles.sheetPhaseSub}>
                  {savingToPhotos ? 'Almost ready to open Instagram.' : 'Almost ready...'}
                </Text>
              </View>
            ) : null}

            {uploadingToStorage ? (
              <View style={styles.sheetPhase}>
                <ActivityIndicator size="large" color="#e1306c" />
                <Text style={styles.sheetPhaseTitle}>Uploading video...</Text>
                <Text style={styles.sheetPhaseSub}>Preparing your video for Instagram.</Text>
                {uploadProgress > 0 ? (
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
                <Text style={styles.sheetPhaseSub}>Adding your hook text to the video.</Text>
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
  hookVariationCard: { padding: Spacing.sm, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border, marginBottom: Spacing.xs, backgroundColor: Colors.surface },
  hookVariationCardActive: { borderColor: Colors.primaryLight, backgroundColor: Colors.primary + '22' },
  hookVariationText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  hookVariationTextActive: { color: Colors.primaryLight, fontWeight: FontWeight.semibold },
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
  audioArtwork: { width: 36, height: 36, borderRadius: Radius.md },
  searchRow: { flexDirection: 'row', gap: Spacing.sm },
  searchInputWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md, borderWidth: 1,
    borderColor: Colors.surfaceBorder, paddingHorizontal: Spacing.sm,
  },
  searchInput: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary, paddingVertical: 11, includeFontPadding: false },
  searchBtn: {
    width: 44, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.primary, borderRadius: Radius.md,
  },
  volumeSection: { gap: Spacing.xs, marginTop: Spacing.sm },
  volumeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.xs },
  volumeLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
  volumeValue: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary, includeFontPadding: false },
  slider: { width: '100%', height: 32 },
  volumeHint: { fontSize: FontSize.xs, color: Colors.textMuted, includeFontPadding: false, marginTop: 2 },
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
  publishSection: {
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md, gap: Spacing.sm,
  },
  publishSectionLabel: {
    fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 1, includeFontPadding: false,
  },
  platformPublishBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    borderRadius: Radius.lg, paddingVertical: Spacing.sm + 4, paddingHorizontal: Spacing.md,
    borderWidth: 2,
  },
  platformPublishBtnDisabled: {
    backgroundColor: Colors.surfaceElevated, borderColor: Colors.surfaceBorder,
  },
  platformPublishName: {
    fontSize: FontSize.md, fontWeight: FontWeight.bold, includeFontPadding: false,
  },
  platformPublishSub: {
    fontSize: FontSize.xs, includeFontPadding: false, marginTop: 1,
  },
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
