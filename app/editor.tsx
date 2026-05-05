import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator, Modal, Dimensions,
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
import { uploadVideoToStorage } from '@/services/tiktokService';
import { uploadToWayin, submitWayinTask, getWayinStatus, WayinClip } from '@/services/wayinVideoService';

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

/** Safely extract a video frame — tries multiple seek positions to avoid dark/black frames */
async function extractVideoFrame(videoUri: string): Promise<{ base64: string; mime: string } | null> {
  try {
    const VideoThumbnails = await import('expo-video-thumbnails');
    const FileSystem = await import('expo-file-system');

    const seekCandidates = [2000, 1000, 500, 0];
    let frameUri: string | null = null;
    for (const seekMs of seekCandidates) {
      try {
        const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, { time: seekMs, quality: 0.6 });
        if (uri) { frameUri = uri; break; }
      } catch { /* try next */ }
    }
    if (!frameUri) return null;

    const base64 = await FileSystem.readAsStringAsync(frameUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return { base64, mime: 'image/jpeg' };
  } catch (e) {
    console.warn('Frame extraction failed:', e);
    return null;
  }
}

/** Strip file extensions, underscores, and timestamp noise from raw filenames */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\.[a-zA-Z0-9]{2,5}$/, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\b\d{4,}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || 'my video';
}

/** Format seconds to M:SS */
function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

async function callAIGenerator(type: string, payload: Record<string, unknown>) {
  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke('ai-content-generator', {
    body: { type, ...payload },
  });
  if (error) {
    let msg = error.message;
    if (error instanceof FunctionsHttpError) {
      try {
        const text = await error.context?.text();
        msg = text || msg;
      } catch { /* ignore */ }
    }
    return { data: null, error: msg };
  }
  return { data, error: null };
}

export default function EditorScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { videos, updateVideo } = useVideos();
  const { showAlert } = useAlert();
  const { user } = useAuth();

  const video = videos.find(v => v.id === id) ?? videos.find(v => v.status === 'ready' || v.status === 'published');

  // ── All hooks MUST run unconditionally before any early return ──
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
  const [tiktokPrivacy, setTiktokPrivacy] = useState('SELF_ONLY');
  const [uploadingToStorage, setUploadingToStorage] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  // WayinVideo state
  const [wayinPhase, setWayinPhase] = useState<'idle' | 'uploading' | 'analyzing' | 'done' | 'error'>('idle');
  const [wayinClips, setWayinClips] = useState<WayinClip[]>([]);
  const [wayinError, setWayinError] = useState<string | null>(null);
  const [showWayinSheet, setShowWayinSheet] = useState(false);

  // Clip detail + trim state
  const [selectedWayinClip, setSelectedWayinClip] = useState<WayinClip | null>(null);
  const [showClipDetailSheet, setShowClipDetailSheet] = useState(false);
  const [trimPhase, setTrimPhase] = useState<'idle' | 'trimming' | 'done' | 'error'>('idle');
  const [trimError, setTrimError] = useState<string | null>(null);

  const wayinPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameCache = useRef<{ base64: string; mime: string } | null | 'pending'>('pending');
  const tiktok = useTikTok();

  // useVideoPlayer MUST be called unconditionally — use empty string when no URI
  const videoPlayer = useVideoPlayer(
    { uri: video?.videoUri ?? '' },
    player => { if (player) player.loop = false; }
  );

  // Sync state from video when it loads
  useEffect(() => {
    if (!video) return;
    setVideoTitle(video.title ?? '');
    setHookType(video.hook?.type ?? 'question');
    setHookText(video.hook?.text ?? '');
    setCaption(video.caption ?? '');
    setHashtags(video.hashtags?.join(' ') ?? '');
    setSelectedAudioId(video.audio?.id ?? '');
    setPlatforms(video.platforms ?? ['tiktok']);
  }, [video?.id]);

  // Auto-generate on first open when video has no hook/caption/audio
  useEffect(() => {
    if (!video || autoGenDone) return;
    const needsHook = !(video.hook?.text?.trim());
    const needsCaption = !(video.caption?.trim());
    const needsAudio = !video.audio?.id;
    if (!needsHook && !needsCaption && !needsAudio) return;
    setAutoGenDone(true);

    const runAll = async () => {
      if (frameCache.current === 'pending') {
        frameCache.current = video.videoUri ? await extractVideoFrame(video.videoUri) : null;
      }
      const frame = frameCache.current !== 'pending' ? frameCache.current : null;
      const framePayload = frame ? { videoFrameBase64: frame.base64, videoFrameMime: frame.mime } : {};
      const currentPlatforms = video.platforms ?? ['tiktok'];
      const cleanedTitle = cleanTitle(video.title);
      const jobs: Promise<void>[] = [];

      if (needsHook) {
        jobs.push((async () => {
          setGeneratingHook(true);
          const { data, error } = await callAIGenerator('hook', {
            videoTitle: cleanedTitle, hookType: video.hook?.type ?? 'question',
            platforms: currentPlatforms, ...framePayload,
          });
          setGeneratingHook(false);
          if (!error && data?.result) {
            setHookText(data.result);
            updateVideo(video.id, { hook: { type: video.hook?.type ?? 'question', text: data.result } });
          }
        })());
      }

      if (needsCaption) {
        jobs.push((async () => {
          setGeneratingCaption(true);
          const { data, error } = await callAIGenerator('caption', {
            videoTitle: cleanedTitle, platforms: currentPlatforms, ...framePayload,
          });
          setGeneratingCaption(false);
          if (!error && data?.result) {
            if (data.result.caption) setCaption(data.result.caption);
            if (data.result.hashtags) setHashtags(data.result.hashtags);
          }
        })());
      }

      if (needsAudio) {
        jobs.push((async () => {
          setGeneratingAudio(true);
          const { data, error } = await callAIGenerator('audio', {
            videoTitle: cleanedTitle, platforms: currentPlatforms, ...framePayload,
          });
          setGeneratingAudio(false);
          if (!error && data?.result?.id) {
            setAiPickedSong(data.result);
            setSelectedAudioId(data.result.id);
          }
        })());
      }

      await Promise.all(jobs);
    };

    runAll();
  }, [video?.id]);

  // ── Early return for missing video — AFTER all hooks ──
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
      if (video) updateVideo(video.id, { title: data.result });
    }
  }, [video, showAlert]);

  const ensureFrame = useCallback(async () => {
    if (frameCache.current === 'pending') {
      frameCache.current = video.videoUri ? await extractVideoFrame(video.videoUri) : null;
    }
    const frame = frameCache.current !== 'pending' ? frameCache.current : null;
    return frame ? { videoFrameBase64: frame.base64, videoFrameMime: frame.mime } : {};
  }, [video.videoUri]);

  const handleGenerateHook = useCallback(async () => {
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
  }, [video.title, video.id, hookType, platforms, showAlert, ensureFrame, updateVideo]);

  const handleGenerateCaption = useCallback(async () => {
    setGeneratingCaption(true);
    const framePayload = await ensureFrame();
    const { data, error } = await callAIGenerator('caption', {
      videoTitle: cleanTitle(video.title), platforms, ...framePayload,
    });
    setGeneratingCaption(false);
    if (error) { showAlert('AI Error', error); return; }
    if (data?.result) {
      if (data.result.caption) setCaption(data.result.caption);
      if (data.result.hashtags) setHashtags(data.result.hashtags);
    }
  }, [video.title, platforms, showAlert, ensureFrame]);

  const handleGenerateAudio = useCallback(async () => {
    setGeneratingAudio(true);
    const framePayload = await ensureFrame();
    const { data, error } = await callAIGenerator('audio', {
      videoTitle: cleanTitle(video.title), platforms, ...framePayload,
    });
    setGeneratingAudio(false);
    if (error) { showAlert('AI Error', error); return; }
    const song = data?.result;
    if (song && song.id) { setAiPickedSong(song); setSelectedAudioId(song.id); }
  }, [video.title, platforms, showAlert, ensureFrame]);

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

  const handlePublish = () => {
    const snap = snapshotEditorState();
    if (platforms.includes('tiktok') && tiktok.status.connected) {
      setShowTikTokSheet(true);
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

  // ── WayinVideo Analysis ────────────────────────────────────────────────────
  const handleWayinAnalyze = async () => {
    let videoUrl = video?.videoUri ?? '';
    if (!videoUrl) { showAlert('No Video', 'Upload a video first before analyzing.'); return; }

    setWayinError(null);
    setWayinClips([]);
    setShowWayinSheet(true);
    setWayinPhase('uploading');

    // Step 1: Ensure we have a public HTTPS URL (upload local files to Supabase storage first)
    if (videoUrl.startsWith('file://') || videoUrl.startsWith('ph://')) {
      const { publicUrl, error: uploadErr } = await uploadVideoToStorage(
        videoUrl, user?.id ?? 'unknown', video.id, () => {},
      );
      if (uploadErr || !publicUrl) {
        setWayinPhase('error');
        setWayinError(uploadErr ?? 'Failed to upload video for analysis.');
        return;
      }
      videoUrl = publicUrl;
      updateVideo(video.id, { videoUri: publicUrl });
    }

    // Step 2: Upload the video to WayinVideo via their pre-signed upload API
    // WayinVideo only accepts files uploaded via their own API or URLs from known platforms
    const fileName = videoUrl.split('/').pop()?.split('?')[0] ?? 'video.mp4';
    const { identity, error: wayinUploadErr } = await uploadToWayin(videoUrl, fileName);
    if (wayinUploadErr || !identity) {
      setWayinPhase('error');
      setWayinError(wayinUploadErr ?? 'Failed to upload video to WayinVideo.');
      return;
    }

    // Step 3: Submit clip analysis task using the WayinVideo identity
    setWayinPhase('analyzing');
    const { taskId, error: submitErr } = await submitWayinTask(identity, videoTitle || video.title || 'ViralCut Video');
    if (submitErr || !taskId) {
      setWayinPhase('error');
      setWayinError(submitErr ?? 'Failed to submit video to WayinVideo.');
      return;
    }

    if (wayinPollRef.current) clearInterval(wayinPollRef.current);
    let attempts = 0;
    const MAX_ATTEMPTS = 30;

    wayinPollRef.current = setInterval(async () => {
      attempts++;
      if (attempts > MAX_ATTEMPTS) {
        clearInterval(wayinPollRef.current!);
        setWayinPhase('error');
        setWayinError('Analysis timed out. Please try again.');
        return;
      }
      const result = await getWayinStatus(taskId);
      if (result.error) return;
      if (result.status === 'SUCCEEDED' || (result.status === 'ONGOING' && result.clips.length > 0)) {
        if (result.status === 'SUCCEEDED') { clearInterval(wayinPollRef.current!); setWayinPhase('done'); }
        setWayinClips(result.clips);
      } else if (result.status === 'FAILED') {
        clearInterval(wayinPollRef.current!);
        setWayinPhase('error');
        setWayinError('WayinVideo analysis failed. Please try again.');
      }
    }, 6000);
  };

  const closeWayinSheet = () => {
    if (wayinPollRef.current) clearInterval(wayinPollRef.current!);
    setShowWayinSheet(false);
    setWayinPhase('idle');
    setWayinError(null);
  };

  /** Apply clip metadata (title/caption/hashtags) without trimming and persist to library */
  const applyClipMeta = (clip: WayinClip, extraVideoFields?: Record<string, unknown>) => {
    const newTitle = clip.title || videoTitle;
    const newCaption = clip.description || caption;
    const newHashtags = clip.hashtags?.length
      ? clip.hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' ')
      : hashtags;

    if (clip.title) setVideoTitle(clip.title);
    if (clip.description) setCaption(clip.description);
    if (clip.hashtags?.length) setHashtags(newHashtags);

    // Persist everything to the video store so it appears in the library
    updateVideo(video.id, {
      title: newTitle,
      caption: newCaption,
      hashtags: newHashtags.split(/\s+/).filter(Boolean),
      hook: { type: hookType, text: hookText },
      platforms,
      status: video.status === 'published' ? 'published' : 'ready',
      ...extraVideoFields,
    });
  };

  /** Open clip detail sheet */
  const handleSelectWayinClip = (clip: WayinClip) => {
    setSelectedWayinClip(clip);
    setTrimPhase('idle');
    setTrimError(null);
    setShowWayinSheet(false);
    setShowClipDetailSheet(true);
  };

  /** Apply content only, no trim */
  const applyWayinClipOnly = () => {
    if (!selectedWayinClip) return;
    applyClipMeta(selectedWayinClip);
    setShowClipDetailSheet(false);
    if (wayinPollRef.current) clearInterval(wayinPollRef.current!);
    setWayinPhase('idle');
    showAlert(
      'Saved to Library!',
      'WayinVideo title, caption and hashtags applied. The video is ready in your library.',
      [
        { text: 'View Library', onPress: () => router.push('/(tabs)/library') },
        { text: 'Keep Editing', style: 'cancel' },
      ],
    );
  };

  /** Headless trim to clip timestamps then apply meta */
  const handleTrimToClip = async () => {
    if (!selectedWayinClip || !video?.videoUri) return;
    const clip = selectedWayinClip;
    const videoUri = video.videoUri;

    if (!videoUri.startsWith('file://') && !videoUri.startsWith('ph://')) {
      showAlert(
        'Trimming Unavailable',
        'The video was already uploaded to cloud storage. Trimming requires the original local file. Apply content only instead.',
        [
          { text: 'Apply Content Only', onPress: applyWayinClipOnly },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
      return;
    }

    setTrimPhase('trimming');
    setTrimError(null);

    try {
      const { trim } = await import('react-native-video-trim');
      const result = await trim(videoUri, {
        startTime: Math.round(clip.start * 1000),
        endTime: Math.round(clip.end * 1000),
      });
      const outputUri = result.outputPath.startsWith('file://') ? result.outputPath : `file://${result.outputPath}`;
      applyClipMeta(clip, { videoUri: outputUri });
      setTrimPhase('done');
    } catch (e: any) {
      console.error('[trim] Error:', e);
      setTrimPhase('error');
      setTrimError(String(e?.message ?? e));
    }
  };

  const closeClipDetailSheet = () => {
    setShowClipDetailSheet(false);
    setTrimPhase('idle');
    setTrimError(null);
    setSelectedWayinClip(null);
    // Re-open clip list if results are available
    if (wayinClips.length > 0) setShowWayinSheet(true);
  };

  const handleTikTokPublish = async () => {
    const snap = snapshotEditorState();
    let videoUrl = video?.videoUri ?? '';

    if (!videoUrl) { showAlert('No Video File', 'Select a video before publishing to TikTok.'); return; }

    if (videoUrl.startsWith('file://') || videoUrl.startsWith('ph://')) {
      setUploadingToStorage(true);
      setUploadProgress(0);
      const { publicUrl, error } = await uploadVideoToStorage(
        videoUrl, user?.id ?? 'unknown', video.id, (pct) => setUploadProgress(pct),
      );
      setUploadingToStorage(false);
      if (error || !publicUrl) { showAlert('Upload Failed', error ?? 'Could not upload video to storage.'); return; }
      videoUrl = publicUrl;
      updateVideo(video.id, { videoUri: publicUrl });
    }

    updateVideo(video.id, { ...snap, title: videoTitle });
    const { error } = await tiktok.publish(
      videoUrl, videoTitle || snap.hook.text || 'ViralCut video', tiktokPrivacy,
    );
    if (error) showAlert('TikTok Error', error);
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

  const selectedClipIdx = selectedWayinClip ? wayinClips.indexOf(selectedWayinClip) : -1;

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
              {video.thumbnail ? (
                <Image source={{ uri: video.thumbnail }} style={styles.previewImg} contentFit="cover" transition={200} />
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
                    <><ActivityIndicator size="small" color={Colors.primaryLight} /><Text style={styles.aiBtnText}>Writing best hook...</Text></>
                  ) : (
                    <><MaterialCommunityIcons name="auto-fix" size={16} color={Colors.primaryLight} /><Text style={styles.aiBtnText}>{hookText ? 'Regenerate Hook' : 'AI Pick Best Hook'}</Text></>
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
                  placeholder="AI will write the best hook, or type your own..."
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
                  placeholder="AI will write your caption, or type your own..."
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

          {/* WayinVideo AI Analyze Button */}
          <View style={styles.wayinRow}>
            <Pressable
              style={({ pressed }) => [
                styles.wayinBtn,
                pressed && { opacity: 0.85 },
                (wayinPhase === 'uploading' || wayinPhase === 'analyzing') ? styles.wayinBtnLoading : null,
              ]}
              onPress={handleWayinAnalyze}
              disabled={wayinPhase === 'uploading' || wayinPhase === 'analyzing'}
            >
              {wayinPhase === 'uploading' || wayinPhase === 'analyzing' ? (
                <>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.wayinBtnText}>
                    {wayinPhase === 'uploading' ? 'Uploading video...' : 'WayinVideo analyzing...'}
                  </Text>
                </>
              ) : (
                <>
                  <MaterialCommunityIcons name="lightning-bolt" size={18} color="#fff" />
                  <Text style={styles.wayinBtnText}>Analyze with WayinVideo AI</Text>
                </>
              )}
            </Pressable>
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

      {/* ── WayinVideo Results Sheet ── */}
      <Modal visible={showWayinSheet} animationType="slide" transparent onRequestClose={closeWayinSheet}>
        <View style={styles.sheetOverlay}>
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={() => { if (wayinPhase !== 'uploading' && wayinPhase !== 'analyzing') closeWayinSheet(); }}
          />
          <View style={[styles.tiktokSheet, { maxHeight: '85%' }]}>
            <View style={styles.sheetHandle} />

            <View style={styles.sheetHeader}>
              <View style={[styles.sheetIcon, { backgroundColor: '#6c47ff' }]}>
                <MaterialCommunityIcons name="lightning-bolt" size={22} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>WayinVideo AI</Text>
                <Text style={styles.sheetSub}>Viral clip detection & trim</Text>
              </View>
              {wayinPhase !== 'uploading' && wayinPhase !== 'analyzing' ? (
                <Pressable onPress={closeWayinSheet} hitSlop={8}>
                  <MaterialIcons name="close" size={20} color={Colors.textMuted} />
                </Pressable>
              ) : null}
            </View>

            {wayinPhase === 'uploading' || wayinPhase === 'analyzing' ? (
              <View style={styles.sheetPhase}>
                <ActivityIndicator size="large" color="#6c47ff" />
                <Text style={styles.sheetPhaseTitle}>
                  {wayinPhase === 'uploading' ? 'Uploading to WayinVideo...' : 'Analyzing your video...'}
                </Text>
                <Text style={styles.sheetPhaseSub}>
                  {wayinPhase === 'uploading'
                    ? 'Transferring your video to WayinVideo for analysis. This may take a moment for large files.'
                    : 'WayinVideo AI is detecting viral moments and generating hooks, captions, and timestamps. This may take up to a minute.'}
                </Text>
              </View>
            ) : null}

            {wayinPhase === 'done' || (wayinPhase === 'analyzing' && wayinClips.length > 0) ? (
              <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 480 }}>
                {wayinPhase === 'done' ? (
                  <View style={styles.wayinSuccessBanner}>
                    <MaterialIcons name="check-circle" size={16} color={Colors.emerald} />
                    <Text style={styles.wayinSuccessText}>
                      {wayinClips.length} viral clip{wayinClips.length !== 1 ? 's' : ''} found — tap to review & trim
                    </Text>
                  </View>
                ) : null}
                {wayinClips.map((clip, idx) => (
                  <Pressable
                    key={idx}
                    style={({ pressed }) => [styles.wayinClipCard, pressed && { opacity: 0.85 }]}
                    onPress={() => handleSelectWayinClip(clip)}
                  >
                    <View style={styles.wayinClipHeader}>
                      <View style={styles.wayinRankBadge}>
                        <Text style={styles.wayinRankText}>#{idx + 1}</Text>
                      </View>
                      {clip.virality_score > 0 ? (
                        <View style={styles.wayinScoreBadge}>
                          <MaterialIcons name="trending-up" size={11} color="#6c47ff" />
                          <Text style={styles.wayinScoreText}>{Math.round(clip.virality_score * 100)}% viral</Text>
                        </View>
                      ) : null}
                      {(clip.start > 0 || clip.end > 0) ? (
                        <View style={styles.wayinTimestampBadge}>
                          <MaterialIcons name="schedule" size={10} color={Colors.textMuted} />
                          <Text style={styles.wayinTimestampText}>
                            {formatTimestamp(clip.start)} – {formatTimestamp(clip.end)}
                          </Text>
                        </View>
                      ) : null}
                      <MaterialIcons name="chevron-right" size={20} color="#6c47ff" style={{ marginLeft: 'auto' }} />
                    </View>
                    <Text style={styles.wayinClipTitle} numberOfLines={2}>{clip.title}</Text>
                    {clip.description ? (
                      <Text style={styles.wayinClipDesc} numberOfLines={2}>{clip.description}</Text>
                    ) : null}
                    {clip.hashtags?.length > 0 ? (
                      <Text style={styles.wayinClipTags} numberOfLines={1}>
                        {clip.hashtags.slice(0, 4).map(h => h.startsWith('#') ? h : `#${h}`).join(' ')}
                      </Text>
                    ) : null}
                    <View style={styles.wayinApplyRow}>
                      <MaterialCommunityIcons name="scissors-cutting" size={12} color="#6c47ff" />
                      <Text style={styles.wayinApplyText}>Tap to review — trim or apply content</Text>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}

            {wayinPhase === 'error' ? (
              <View style={styles.sheetPhase}>
                <MaterialIcons name="error-outline" size={52} color={Colors.error} />
                <Text style={styles.sheetPhaseTitle}>Analysis Failed</Text>
                <Text style={styles.sheetPhaseSub}>{wayinError}</Text>
                <Pressable
                  style={[styles.tiktokPublishBtn, { marginTop: Spacing.md, backgroundColor: '#6c47ff' }]}
                  onPress={() => { closeWayinSheet(); handleWayinAnalyze(); }}
                >
                  <Text style={styles.tiktokPublishBtnText}>Try Again</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>

      {/* ── Clip Detail & Trim Sheet ── */}
      <Modal visible={showClipDetailSheet} animationType="slide" transparent onRequestClose={closeClipDetailSheet}>
        <View style={styles.sheetOverlay}>
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={() => { if (trimPhase !== 'trimming') closeClipDetailSheet(); }}
          />
          <View style={[styles.tiktokSheet, { maxHeight: '92%' }]}>
            <View style={styles.sheetHandle} />

            <View style={styles.sheetHeader}>
              <View style={[styles.sheetIcon, { backgroundColor: '#6c47ff' }]}>
                <MaterialCommunityIcons name="scissors-cutting" size={20} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>
                  Viral Clip {selectedClipIdx >= 0 ? `#${selectedClipIdx + 1}` : ''}
                </Text>
                <Text style={styles.sheetSub}>Review, trim or apply content to editor</Text>
              </View>
              {trimPhase !== 'trimming' ? (
                <Pressable onPress={closeClipDetailSheet} hitSlop={8}>
                  <MaterialIcons name="close" size={20} color={Colors.textMuted} />
                </Pressable>
              ) : null}
            </View>

            {selectedWayinClip && trimPhase === 'idle' ? (
              <ScrollView showsVerticalScrollIndicator={false}>
                {/* Timestamp bar */}
                {(selectedWayinClip.start > 0 || selectedWayinClip.end > 0) ? (
                  <View style={styles.clipTimestampBar}>
                    <View style={styles.clipTimestampItem}>
                      <Text style={styles.clipTimestampLabel}>START</Text>
                      <Text style={styles.clipTimestampValue}>{formatTimestamp(selectedWayinClip.start)}</Text>
                    </View>
                    <View style={styles.clipDurationPill}>
                      <MaterialCommunityIcons name="scissors-cutting" size={12} color="#6c47ff" />
                      <Text style={styles.clipDurationText}>
                        {formatTimestamp(Math.max(0, selectedWayinClip.end - selectedWayinClip.start))}
                      </Text>
                    </View>
                    <View style={styles.clipTimestampItem}>
                      <Text style={styles.clipTimestampLabel}>END</Text>
                      <Text style={styles.clipTimestampValue}>{formatTimestamp(selectedWayinClip.end)}</Text>
                    </View>
                  </View>
                ) : null}

                {/* Virality score bar */}
                {selectedWayinClip.virality_score > 0 ? (
                  <View style={styles.clipViralRow}>
                    <MaterialIcons name="trending-up" size={14} color="#6c47ff" />
                    <Text style={styles.clipViralLabel}>Viral Score</Text>
                    <View style={styles.clipViralBarBg}>
                      <View style={[styles.clipViralBarFill, { width: `${Math.min(100, Math.round(selectedWayinClip.virality_score * 100))}%` as any }]} />
                    </View>
                    <Text style={styles.clipViralPct}>{Math.round(selectedWayinClip.virality_score * 100)}%</Text>
                  </View>
                ) : null}

                {selectedWayinClip.title ? (
                  <View style={styles.clipMetaSection}>
                    <Text style={styles.clipMetaLabel}>TITLE</Text>
                    <Text style={styles.clipMetaValue}>{selectedWayinClip.title}</Text>
                  </View>
                ) : null}

                {selectedWayinClip.description ? (
                  <View style={styles.clipMetaSection}>
                    <Text style={styles.clipMetaLabel}>CAPTION</Text>
                    <Text style={styles.clipMetaValue}>{selectedWayinClip.description}</Text>
                  </View>
                ) : null}

                {selectedWayinClip.hashtags?.length > 0 ? (
                  <View style={styles.clipMetaSection}>
                    <Text style={styles.clipMetaLabel}>HASHTAGS</Text>
                    <View style={styles.clipHashtagRow}>
                      {selectedWayinClip.hashtags.slice(0, 8).map((h, i) => (
                        <View key={i} style={styles.clipHashtagChip}>
                          <Text style={styles.clipHashtagText}>{h.startsWith('#') ? h : `#${h}`}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                ) : null}

                {/* Primary action: Trim */}
                <Pressable
                  style={({ pressed }) => [styles.clipTrimBtn, pressed && { opacity: 0.85 }]}
                  onPress={handleTrimToClip}
                >
                  <MaterialCommunityIcons name="scissors-cutting" size={20} color="#fff" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.clipTrimBtnTitle}>Trim Video to This Clip</Text>
                    {(selectedWayinClip.start > 0 || selectedWayinClip.end > 0) ? (
                      <Text style={styles.clipTrimBtnSub}>
                        {formatTimestamp(selectedWayinClip.start)} – {formatTimestamp(selectedWayinClip.end)}
                        {' · '}{formatTimestamp(Math.max(0, selectedWayinClip.end - selectedWayinClip.start))} segment
                      </Text>
                    ) : null}
                  </View>
                  <MaterialIcons name="chevron-right" size={20} color="rgba(255,255,255,0.7)" />
                </Pressable>

                {/* Secondary action: Apply content only */}
                <Pressable
                  style={({ pressed }) => [styles.clipActionBtnOutline, pressed && { opacity: 0.8 }]}
                  onPress={applyWayinClipOnly}
                >
                  <MaterialCommunityIcons name="auto-fix" size={15} color="#6c47ff" />
                  <Text style={styles.clipActionBtnOutlineText}>Apply Content Only (no trim)</Text>
                </Pressable>

                <Text style={styles.clipTrimNote}>
                  Trimming cuts your video file to just this segment before posting. Your original file stays on device.
                </Text>
              </ScrollView>
            ) : null}

            {trimPhase === 'trimming' ? (
              <View style={styles.sheetPhase}>
                <ActivityIndicator size="large" color="#6c47ff" />
                <Text style={styles.sheetPhaseTitle}>Trimming video...</Text>
                <Text style={styles.sheetPhaseSub}>
                  Cutting to{' '}
                  {selectedWayinClip
                    ? `${formatTimestamp(selectedWayinClip.start)} – ${formatTimestamp(selectedWayinClip.end)}`
                    : 'selected segment'}
                  . This may take a moment.
                </Text>
              </View>
            ) : null}

            {trimPhase === 'done' ? (
              <View style={styles.sheetPhase}>
                <MaterialIcons name="check-circle" size={56} color={Colors.emerald} />
                <Text style={styles.sheetPhaseTitle}>Video Trimmed!</Text>
                <Text style={styles.sheetPhaseSub}>
                  Your video is cut to the viral segment and content applied. Ready to publish!
                </Text>
                <Pressable
                  style={[styles.tiktokPublishBtn, { marginTop: Spacing.md, backgroundColor: '#6c47ff' }]}
                  onPress={() => {
                    setShowClipDetailSheet(false);
                    setTrimPhase('idle');
                    setSelectedWayinClip(null);
                    setWayinPhase('idle');
                    router.push('/(tabs)/library');
                  }}
                >
                  <MaterialIcons name="video-library" size={18} color="#fff" />
                  <Text style={styles.tiktokPublishBtnText}>View in Library</Text>
                </Pressable>
              </View>
            ) : null}

            {trimPhase === 'error' ? (
              <View style={styles.sheetPhase}>
                <MaterialIcons name="error-outline" size={52} color={Colors.error} />
                <Text style={styles.sheetPhaseTitle}>Trim Failed</Text>
                <Text style={styles.sheetPhaseSub}>{trimError}</Text>
                <Pressable
                  style={[styles.tiktokPublishBtn, { marginTop: Spacing.md, backgroundColor: Colors.error }]}
                  onPress={() => setTrimPhase('idle')}
                >
                  <Text style={styles.tiktokPublishBtnText}>Try Again</Text>
                </Pressable>
                <Pressable
                  style={[styles.clipActionBtnOutline, { marginTop: Spacing.sm }]}
                  onPress={applyWayinClipOnly}
                >
                  <MaterialCommunityIcons name="auto-fix" size={14} color="#6c47ff" />
                  <Text style={styles.clipActionBtnOutlineText}>Apply Content Only Instead</Text>
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

            {uploadingToStorage ? (
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
                  {tiktok.publishState.phase === 'processing'
                    ? 'This can take up to 2 minutes.'
                    : 'Connecting to TikTok API...'}
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
            <VideoView player={videoPlayer} style={styles.videoView} contentFit="contain" nativeControls />
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
    backgroundColor: Colors.primaryGlow, borderRadius: Radius.full, paddingVertical: 12,
    borderWidth: 1.5, borderColor: Colors.primary, minHeight: 46,
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
    backgroundColor: Colors.primaryGlow, borderRadius: Radius.full, paddingHorizontal: 5, paddingVertical: 2,
  },
  trendingText: { fontSize: 10, color: Colors.primaryLight, fontWeight: FontWeight.bold, includeFontPadding: false },
  audioUses: { fontSize: 10, color: Colors.textMuted, includeFontPadding: false },
  platformRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md,
    padding: Spacing.sm + 4, borderWidth: 1.5, borderColor: Colors.surfaceBorder,
  },
  platformRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryGlow },
  platformLabel: { flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.semibold, color: Colors.textPrimary, includeFontPadding: false },
  checkbox: { width: 22, height: 22, borderRadius: Radius.sm, borderWidth: 2, borderColor: Colors.surfaceBorder, alignItems: 'center', justifyContent: 'center' },
  checkboxActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  actions: { flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.md, paddingTop: Spacing.lg },
  scheduleBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.full, paddingVertical: 14,
    borderWidth: 1.5, borderColor: Colors.primary,
  },
  scheduleBtnText: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: Colors.primaryLight, includeFontPadding: false },
  publishBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: Colors.primary, borderRadius: Radius.full, paddingVertical: 14,
  },
  publishBtnText: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  playerModal: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  playerClose: {
    position: 'absolute', top: Platform.OS === 'ios' ? 56 : 40, right: 20, zIndex: 10,
    width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  playerTitle: {
    position: 'absolute', top: Platform.OS === 'ios' ? 56 : 40, left: 20, right: 70, zIndex: 10,
    fontSize: FontSize.md, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false,
  },
  videoView: { width: Dimensions.get('window').width, height: Dimensions.get('window').height },
  noVideoContainer: {
    width: Dimensions.get('window').width, height: Dimensions.get('window').height * 0.65,
    borderRadius: Radius.lg, overflow: 'hidden', position: 'relative',
  },
  noVideoThumb: { width: '100%', height: '100%' },
  noVideoOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.65)', alignItems: 'center', justifyContent: 'center',
    gap: 10, paddingHorizontal: Spacing.lg,
  },
  noVideoText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: '#fff', textAlign: 'center', includeFontPadding: false },
  noVideoSub: { fontSize: FontSize.sm, color: 'rgba(255,255,255,0.65)', textAlign: 'center', lineHeight: 20, includeFontPadding: false },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, includeFontPadding: false },
  uploadBtn: { backgroundColor: Colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: Radius.full },
  uploadBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: FontWeight.bold, includeFontPadding: false },
  progressBarBg: { width: '80%', height: 6, borderRadius: 3, backgroundColor: Colors.surfaceBorder, overflow: 'hidden', marginTop: 4 },
  progressBarFill: { height: '100%', borderRadius: 3, backgroundColor: Colors.primaryLight },

  // WayinVideo button
  wayinRow: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  wayinBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#6c47ff', borderRadius: Radius.full, paddingVertical: 13, minHeight: 46,
  },
  wayinBtnLoading: { opacity: 0.75 },
  wayinBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },

  // WayinVideo results sheet
  wayinSuccessBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.emerald + '18', borderRadius: Radius.md,
    paddingHorizontal: Spacing.sm, paddingVertical: 8, marginBottom: Spacing.sm,
  },
  wayinSuccessText: { fontSize: FontSize.sm, color: Colors.emerald, fontWeight: FontWeight.semibold, includeFontPadding: false },
  wayinClipCard: {
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.lg,
    padding: Spacing.md, marginBottom: Spacing.sm, borderWidth: 1.5, borderColor: '#6c47ff33', gap: Spacing.xs,
  },
  wayinClipHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  wayinRankBadge: { backgroundColor: '#6c47ff', borderRadius: Radius.full, paddingHorizontal: 7, paddingVertical: 2 },
  wayinRankText: { fontSize: 10, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  wayinScoreBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    backgroundColor: '#6c47ff22', borderRadius: Radius.full, paddingHorizontal: 6, paddingVertical: 2,
  },
  wayinScoreText: { fontSize: 10, color: '#6c47ff', fontWeight: FontWeight.bold, includeFontPadding: false },
  wayinTimestampBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.full, paddingHorizontal: 6, paddingVertical: 2,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  wayinTimestampText: { fontSize: 10, color: Colors.textMuted, fontWeight: FontWeight.medium, includeFontPadding: false },
  wayinClipTitle: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: Colors.textPrimary, includeFontPadding: false },
  wayinClipDesc: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18, includeFontPadding: false },
  wayinClipTags: { fontSize: FontSize.xs, color: '#6c47ff', fontWeight: FontWeight.medium, includeFontPadding: false },
  wayinApplyRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  wayinApplyText: { fontSize: FontSize.xs, color: '#6c47ff', fontWeight: FontWeight.semibold, includeFontPadding: false },

  // Clip detail sheet
  clipTimestampBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#6c47ff18', borderRadius: Radius.md, padding: Spacing.md,
    marginBottom: Spacing.sm, borderWidth: 1, borderColor: '#6c47ff33',
  },
  clipTimestampItem: { alignItems: 'center', gap: 4 },
  clipTimestampLabel: {
    fontSize: 9, fontWeight: FontWeight.bold, color: Colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8, includeFontPadding: false,
  },
  clipTimestampValue: { fontSize: 26, fontWeight: FontWeight.bold, color: '#6c47ff', includeFontPadding: false },
  clipDurationPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#6c47ff33', borderRadius: Radius.full, paddingHorizontal: 12, paddingVertical: 6,
  },
  clipDurationText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: '#6c47ff', includeFontPadding: false },
  clipViralRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: Spacing.sm },
  clipViralLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: FontWeight.semibold, includeFontPadding: false },
  clipViralBarBg: { flex: 1, height: 6, borderRadius: 3, backgroundColor: Colors.surfaceBorder, overflow: 'hidden' },
  clipViralBarFill: { height: '100%', borderRadius: 3, backgroundColor: '#6c47ff' },
  clipViralPct: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: '#6c47ff', width: 32, textAlign: 'right', includeFontPadding: false },
  clipMetaSection: { marginBottom: Spacing.sm },
  clipMetaLabel: {
    fontSize: 9, fontWeight: FontWeight.bold, color: Colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4, includeFontPadding: false,
  },
  clipMetaValue: { fontSize: FontSize.sm, color: Colors.textPrimary, lineHeight: 20, includeFontPadding: false },
  clipHashtagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  clipHashtagChip: {
    backgroundColor: '#6c47ff18', borderRadius: Radius.full,
    paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: '#6c47ff33',
  },
  clipHashtagText: { fontSize: FontSize.xs, color: '#6c47ff', fontWeight: FontWeight.semibold, includeFontPadding: false },
  clipTrimBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#6c47ff', borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm,
  },
  clipTrimBtnTitle: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  clipTrimBtnSub: { fontSize: FontSize.xs, color: 'rgba(255,255,255,0.7)', marginTop: 2, includeFontPadding: false },
  clipActionBtnOutline: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: Radius.full, paddingVertical: 13, borderWidth: 1.5, borderColor: '#6c47ff',
    backgroundColor: '#6c47ff18', marginBottom: Spacing.sm,
  },
  clipActionBtnOutlineText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: '#6c47ff', includeFontPadding: false },
  clipTrimNote: {
    fontSize: FontSize.xs, color: Colors.textMuted, textAlign: 'center',
    lineHeight: 16, paddingHorizontal: Spacing.sm, marginBottom: Spacing.md, includeFontPadding: false,
  },

  // Shared sheet styles
  sheetOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  tiktokSheet: {
    backgroundColor: Colors.surface, borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
    padding: Spacing.lg, paddingBottom: Spacing.xxl, gap: Spacing.md,
    borderTopWidth: 1, borderColor: Colors.surfaceBorder,
  },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.surfaceBorder, alignSelf: 'center', marginBottom: Spacing.xs },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: 4 },
  sheetIcon: { width: 44, height: 44, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  sheetTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, includeFontPadding: false },
  sheetSub: { fontSize: FontSize.xs, color: Colors.textMuted, includeFontPadding: false },
  sheetSectionLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, includeFontPadding: false },
  privacyRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md,
    padding: Spacing.sm + 4, borderWidth: 1.5, borderColor: Colors.surfaceBorder,
  },
  privacyRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryGlow },
  privacyLabel: { flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.semibold, color: Colors.textSecondary, includeFontPadding: false },
  privacyLabelActive: { color: Colors.textPrimary },
  sheetNote: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', paddingHorizontal: 2 },
  sheetNoteText: { flex: 1, fontSize: FontSize.xs, color: Colors.textMuted, lineHeight: 16, includeFontPadding: false },
  tiktokPublishBtn: {
    backgroundColor: '#010101', borderRadius: Radius.full, paddingVertical: 16,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
  },
  tiktokPublishBtnText: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  sheetPhase: { alignItems: 'center', gap: 12, paddingVertical: Spacing.lg },
  sheetPhaseTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, textAlign: 'center', includeFontPadding: false },
  sheetPhaseSub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20, paddingHorizontal: Spacing.md, includeFontPadding: false },
});
