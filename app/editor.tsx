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
import * as FileSystem from 'expo-file-system';

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

/** Safely extract a video frame for audio AI analysis only */
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

  // Hook/caption generation state (now via WayinVideo)
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
  // Which field triggered the current WayinVideo run
  const [wayinTarget, setWayinTarget] = useState<'hook' | 'caption' | 'both' | 'browse'>('both');

  // Clip detail + trim state
  const [selectedWayinClip, setSelectedWayinClip] = useState<WayinClip | null>(null);
  const [showClipDetailSheet, setShowClipDetailSheet] = useState(false);
  const [trimPhase, setTrimPhase] = useState<'idle' | 'trimming' | 'done' | 'error'>('idle');
  const [trimError, setTrimError] = useState<string | null>(null);

  // Thumbnail generation state
  const [generatingThumbnail, setGeneratingThumbnail] = useState(false);
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(video?.thumbnail ?? null);

  // Filmstrip state (clip detail sheet)
  const [filmstripFrames, setFilmstripFrames] = useState<{ uri: string; ts: number }[]>([]);
  const [filmstripLoading, setFilmstripLoading] = useState(false);
  const [filmstripSelectedIdx, setFilmstripSelectedIdx] = useState<number | null>(null);
  const filmstripCacheRef = useRef<Record<string, { uri: string; ts: number }[]>>({});

  const wayinPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Extract thumbnail from video at a specific timestamp (seconds) ───────────
  const generateThumbnailFromTimestamp = useCallback(async (
    videoUri: string,
    timestampSeconds: number,
  ): Promise<string | null> => {
    try {
      const { getFrameAt } = await import('react-native-video-trim');
      const ts = Math.max(0, Math.round(timestampSeconds * 1000));
      const { outputPath } = await getFrameAt(videoUri, {
        time: ts,
        format: 'jpeg',
        quality: 88,
        maxWidth: 720,
      });
      return outputPath.startsWith('file://') ? outputPath : `file://${outputPath}`;
    } catch (e) {
      console.warn('[thumbnail] getFrameAt failed, trying expo-video-thumbnails:', e);
      try {
        const VideoThumbnails = await import('expo-video-thumbnails');
        const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
          time: Math.max(0, Math.round(timestampSeconds * 1000)),
          quality: 0.85,
        });
        return uri ?? null;
      } catch (e2) {
        console.warn('[thumbnail] expo-video-thumbnails also failed:', e2);
        return null;
      }
    }
  }, []);
  // Cache for WayinVideo public URL (to avoid re-uploading)
  const wayinPublicUrlRef = useRef<string | null>(null);
  const frameCache = useRef<{ base64: string; mime: string } | null | 'pending'>('pending');
  const tiktok = useTikTok();

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
    setThumbnailUri(video.thumbnail ?? null);
  }, [video?.id]);

  // ── Auto-generate on first open using WayinVideo for hook/caption, Gemini for audio ──
  useEffect(() => {
    if (!video || autoGenDone) return;
    const needsHook = !(video.hook?.text?.trim());
    const needsCaption = !(video.caption?.trim());
    const needsAudio = !video.audio?.id;
    if (!needsHook && !needsCaption && !needsAudio) return;
    setAutoGenDone(true);

    const runAll = async () => {
      // WayinVideo handles hook + caption
      if (needsHook || needsCaption) {
        const target = needsHook && needsCaption ? 'both' : needsHook ? 'hook' : 'caption';
        setWayinTarget(target);
        // Run silently without showing sheet — just populate fields
        await runWayinAnalysisInternal({
          target,
          silent: true,
          onHook: (text) => {
            setHookText(text);
            updateVideo(video.id, { hook: { type: video.hook?.type ?? 'question', text } });
          },
          onCaption: (cap, tags) => {
            if (cap) setCaption(cap);
            if (tags) setHashtags(tags);
          },
        });
      }

      // Gemini still handles audio
      if (needsAudio) {
        if (frameCache.current === 'pending') {
          frameCache.current = video.videoUri ? await extractVideoFrame(video.videoUri) : null;
        }
        const frame = frameCache.current !== 'pending' ? frameCache.current : null;
        const framePayload = frame ? { videoFrameBase64: frame.base64, videoFrameMime: frame.mime } : {};
        setGeneratingAudio(true);
        const { data, error } = await callAIGenerator('audio', {
          videoTitle: cleanTitle(video.title), platforms: video.platforms ?? ['tiktok'], ...framePayload,
        });
        setGeneratingAudio(false);
        if (!error && data?.result?.id) {
          setAiPickedSong(data.result);
          setSelectedAudioId(data.result.id);
        }
      }
    };

    runAll();
  }, [video?.id]);

  // ── Extract filmstrip frames for a clip ──────────────────────────────────────
  const extractFilmstripFrames = useCallback(async (clip: WayinClip, videoUri: string) => {
    const cacheKey = `${clip.start}-${clip.end}-${videoUri}`;
    if (filmstripCacheRef.current[cacheKey]) {
      setFilmstripFrames(filmstripCacheRef.current[cacheKey]);
      setFilmstripSelectedIdx(null);
      return;
    }
    setFilmstripLoading(true);
    setFilmstripFrames([]);
    setFilmstripSelectedIdx(null);

    const FRAME_COUNT = 6;
    const start = Math.max(0, clip.start);
    const end = Math.max(start + 1, clip.end);
    const duration = end - start;
    const seekPoints = Array.from({ length: FRAME_COUNT }, (_, i) =>
      start + (duration * i) / (FRAME_COUNT - 1)
    );

    const results: { uri: string; ts: number }[] = [];
    for (const ts of seekPoints) {
      try {
        const uri = await generateThumbnailFromTimestamp(videoUri, ts);
        if (uri) results.push({ uri, ts });
      } catch { /* skip failed frames */ }
    }

    filmstripCacheRef.current[cacheKey] = results;
    setFilmstripFrames(results);
    setFilmstripLoading(false);
  }, [generateThumbnailFromTimestamp]);

  // ── Generate thumbnail from best WayinVideo clip ─────────────────────────────
  const generateWayinThumbnail = useCallback(async (clip: WayinClip, videoUri: string) => {
    if (generatingThumbnail) return;
    setGeneratingThumbnail(true);
    try {
      // Use clip start + 1 second for a better frame (avoid cut-in artifacts)
      const seekSeconds = clip.start > 0 ? clip.start + 1 : Math.max(0, clip.start);
      const newThumb = await generateThumbnailFromTimestamp(videoUri, seekSeconds);
      if (newThumb) {
        setThumbnailUri(newThumb);
        updateVideo(video!.id, { thumbnail: newThumb });
        return newThumb;
      }
    } catch (e) {
      console.warn('[thumbnail] WayinVideo thumbnail generation failed:', e);
    } finally {
      setGeneratingThumbnail(false);
    }
    return null;
  }, [generatingThumbnail, generateThumbnailFromTimestamp, updateVideo, video]);

  // ── Core WayinVideo analysis engine ──────────────────────────────────────────
  /**
   * Internal: runs upload → submit → poll without touching sheet UI.
   * Callbacks fire when results arrive.
   */
  const runWayinAnalysisInternal = useCallback(async (opts: {
    target: 'hook' | 'caption' | 'both' | 'browse';
    silent?: boolean;
    onHook?: (text: string) => void;
    onCaption?: (caption: string, hashtags: string) => void;
    onClips?: (clips: WayinClip[]) => void;
  }) => {
    if (!video) return { error: 'No video' };

    let videoUrl = video.videoUri ?? '';
    if (!videoUrl) return { error: 'No video URI' };

    // Step 1: Ensure public HTTPS URL (use cache if available)
    if (videoUrl.startsWith('file://') || videoUrl.startsWith('ph://')) {
      if (wayinPublicUrlRef.current) {
        videoUrl = wayinPublicUrlRef.current;
      } else {
        if (!opts.silent) setWayinPhase('uploading');
        const { publicUrl, error: uploadErr } = await uploadVideoToStorage(
          videoUrl, user?.id ?? 'unknown', video.id, () => {},
        );
        if (uploadErr || !publicUrl) {
          if (!opts.silent) { setWayinPhase('error'); setWayinError(uploadErr ?? 'Upload failed.'); }
          return { error: uploadErr ?? 'Upload failed.' };
        }
        videoUrl = publicUrl;
        wayinPublicUrlRef.current = publicUrl;
        updateVideo(video.id, { videoUri: publicUrl });
      }
    } else {
      wayinPublicUrlRef.current = videoUrl;
    }

    // Step 2: Upload to WayinVideo (pre-signed)
    if (!opts.silent) setWayinPhase('uploading');
    const fileName = videoUrl.split('/').pop()?.split('?')[0] ?? 'video.mp4';
    const { identity, error: wayinUpErr } = await uploadToWayin(videoUrl, fileName);
    if (wayinUpErr || !identity) {
      if (!opts.silent) { setWayinPhase('error'); setWayinError(wayinUpErr ?? 'WayinVideo upload failed.'); }
      return { error: wayinUpErr ?? 'WayinVideo upload failed.' };
    }

    // Step 3: Submit task
    if (!opts.silent) setWayinPhase('analyzing');
    const { taskId, error: submitErr } = await submitWayinTask(identity, videoTitle || video.title || 'ViralCut Video');
    if (submitErr || !taskId) {
      if (!opts.silent) { setWayinPhase('error'); setWayinError(submitErr ?? 'Submit failed.'); }
      return { error: submitErr ?? 'Submit failed.' };
    }

    // Step 4: Poll
    return new Promise<{ clips?: WayinClip[]; error?: string }>((resolve) => {
      if (wayinPollRef.current) clearInterval(wayinPollRef.current);
      let attempts = 0;
      const MAX_ATTEMPTS = 30;
      let appliedOnce = false;

      wayinPollRef.current = setInterval(async () => {
        attempts++;
        if (attempts > MAX_ATTEMPTS) {
          clearInterval(wayinPollRef.current!);
          const msg = 'Analysis timed out. Please try again.';
          if (!opts.silent) { setWayinPhase('error'); setWayinError(msg); }
          resolve({ error: msg });
          return;
        }

        const result = await getWayinStatus(taskId);
        if (result.error) return;

        if (result.clips.length > 0) {
          if (!opts.silent) setWayinClips(result.clips);
          opts.onClips?.(result.clips);

          // Apply best clip immediately on first results
          if (!appliedOnce && result.clips.length > 0) {
            appliedOnce = true;
            const best = result.clips[0];
            const target = opts.target;
            if ((target === 'hook' || target === 'both') && best.title) {
              opts.onHook?.(best.title);
            }
            if ((target === 'caption' || target === 'both') && best.description) {
              const tags = best.hashtags?.length
                ? best.hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' ')
                : '';
              opts.onCaption?.(best.description, tags);
            }
            // Auto-generate thumbnail from the best viral clip's start timestamp
            if (video?.videoUri && best.start >= 0) {
              const videoUri = wayinPublicUrlRef.current ?? video.videoUri;
              generateThumbnailFromTimestamp(videoUri, Math.max(0, best.start + 1))
                .then(thumb => {
                  if (thumb) {
                    setThumbnailUri(thumb);
                    updateVideo(video.id, { thumbnail: thumb });
                  }
                })
                .catch(console.warn);
            }
          }
        }

        if (result.status === 'SUCCEEDED') {
          clearInterval(wayinPollRef.current!);
          if (!opts.silent) setWayinPhase('done');
          resolve({ clips: result.clips });
        } else if (result.status === 'FAILED') {
          clearInterval(wayinPollRef.current!);
          const msg = 'WayinVideo analysis failed. Please try again.';
          if (!opts.silent) { setWayinPhase('error'); setWayinError(msg); }
          resolve({ error: msg });
        }
      }, 6000);
    });
  }, [video, user, videoTitle, updateVideo]);

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

  // ── Generate Hook (via WayinVideo) ──────────────────────────────────────────
  const handleGenerateHook = async () => {
    // If we already have clips cached, apply instantly
    if (wayinClips.length > 0) {
      const best = wayinClips[0];
      if (best.title) {
        setHookText(best.title);
        updateVideo(video.id, { hook: { type: hookType, text: best.title } });
      }
      // Show sheet so user can browse other clips
      setWayinTarget('hook');
      setShowWayinSheet(true);
      return;
    }

    setGeneratingHook(true);
    setWayinTarget('hook');
    setWayinError(null);
    setWayinClips([]);

    await runWayinAnalysisInternal({
      target: 'hook',
      silent: false,
      onHook: (text) => {
        setHookText(text);
        updateVideo(video.id, { hook: { type: hookType, text } });
      },
      onClips: () => {}, // clips set internally
    });

    setGeneratingHook(false);

    // Show the clip browser if we got results
    if (wayinClips.length > 0) setShowWayinSheet(true);
  };

  // ── Generate Caption (via WayinVideo) ───────────────────────────────────────
  const handleGenerateCaption = async () => {
    if (wayinClips.length > 0) {
      const best = wayinClips[0];
      if (best.description) setCaption(best.description);
      if (best.hashtags?.length) {
        setHashtags(best.hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' '));
      }
      setWayinTarget('caption');
      setShowWayinSheet(true);
      return;
    }

    setGeneratingCaption(true);
    setWayinTarget('caption');
    setWayinError(null);
    setWayinClips([]);

    await runWayinAnalysisInternal({
      target: 'caption',
      silent: false,
      onCaption: (cap, tags) => {
        if (cap) setCaption(cap);
        if (tags) setHashtags(tags);
      },
      onClips: () => {},
    });

    setGeneratingCaption(false);
    if (wayinClips.length > 0) setShowWayinSheet(true);
  };

  // ── Generate Audio (Gemini) ──────────────────────────────────────────────────
  const ensureFrame = useCallback(async () => {
    if (frameCache.current === 'pending') {
      frameCache.current = video.videoUri ? await extractVideoFrame(video.videoUri) : null;
    }
    const frame = frameCache.current !== 'pending' ? frameCache.current : null;
    return frame ? { videoFrameBase64: frame.base64, videoFrameMime: frame.mime } : {};
  }, [video.videoUri]);

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
  }, [video, showAlert, ensureFrame, updateVideo]);

  // ── Browse all clips (manual button) ────────────────────────────────────────
  const handleBrowseClips = async () => {
    if (wayinClips.length > 0) {
      setWayinTarget('browse');
      setShowWayinSheet(true);
      return;
    }
    setWayinTarget('browse');
    setWayinError(null);
    setWayinClips([]);
    setShowWayinSheet(true);
    setWayinPhase('uploading');

    await runWayinAnalysisInternal({
      target: 'browse',
      silent: false,
      onClips: () => {},
    });
  };

  const closeWayinSheet = () => {
    if (wayinPollRef.current) clearInterval(wayinPollRef.current!);
    setShowWayinSheet(false);
    setWayinPhase('idle');
    setWayinError(null);
  };

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

  /** Apply clip metadata to editor and persist to library */
  const applyClipMeta = (clip: WayinClip, extraVideoFields?: Record<string, unknown>) => {
    const newTitle = clip.title || videoTitle;
    const newCaption = clip.description || caption;
    const newHashtags = clip.hashtags?.length
      ? clip.hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' ')
      : hashtags;

    if (clip.title) {
      setHookText(clip.title);
      setVideoTitle(clip.title);
    }
    if (clip.description) setCaption(clip.description);
    if (clip.hashtags?.length) setHashtags(newHashtags);

    updateVideo(video.id, {
      title: newTitle,
      caption: newCaption,
      hashtags: newHashtags.split(/\s+/).filter(Boolean),
      hook: { type: hookType, text: clip.title || hookText },
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
    // Kick off filmstrip extraction
    const videoUri = wayinPublicUrlRef.current ?? video?.videoUri ?? '';
    if (videoUri) extractFilmstripFrames(clip, videoUri);
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
      'WayinVideo hook, caption and hashtags applied.',
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
        'The video was already uploaded to cloud storage. Trimming requires the original local file.',
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
    setFilmstripFrames([]);
    setFilmstripSelectedIdx(null);
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
  const isWayinRunning = wayinPhase === 'uploading' || wayinPhase === 'analyzing';

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
              {/* Thumbnail refresh button */}
              <Pressable
                style={styles.thumbRefreshBtn}
                onPress={async () => {
                  if (!video?.videoUri || generatingThumbnail) return;
                  setGeneratingThumbnail(true);
                  const videoUri = wayinPublicUrlRef.current ?? video.videoUri;
                  const seekSec = wayinClips.length > 0 ? Math.max(0, wayinClips[0].start + 1) : 2;
                  const thumb = await generateThumbnailFromTimestamp(videoUri, seekSec);
                  if (thumb) {
                    setThumbnailUri(thumb);
                    updateVideo(video.id, { thumbnail: thumb });
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

          {/* WayinVideo clips available banner */}
          {wayinClips.length > 0 ? (
            <Pressable style={styles.clipsBanner} onPress={handleBrowseClips}>
              <MaterialCommunityIcons name="lightning-bolt" size={14} color="#6c47ff" />
              <Text style={styles.clipsBannerText}>
                {wayinClips.length} viral clip{wayinClips.length !== 1 ? 's' : ''} detected — tap to browse
              </Text>
              <MaterialIcons name="chevron-right" size={16} color="#6c47ff" />
            </Pressable>
          ) : null}

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

                {/* WayinVideo-powered hook button */}
                <Pressable
                  style={({ pressed }) => [styles.wayinAiBtn, pressed && { opacity: 0.85 }, generatingHook && styles.aiBtnLoading]}
                  onPress={handleGenerateHook}
                  disabled={generatingHook || isWayinRunning}
                >
                  {generatingHook ? (
                    <><ActivityIndicator size="small" color="#fff" /><Text style={styles.wayinAiBtnText}>Analyzing video...</Text></>
                  ) : (
                    <>
                      <MaterialCommunityIcons name="lightning-bolt" size={16} color="#fff" />
                      <Text style={styles.wayinAiBtnText}>{hookText ? 'Regenerate Hook' : 'AI Generate Hook'}</Text>
                      <View style={styles.wayinBadge}><Text style={styles.wayinBadgeText}>WayinVideo</Text></View>
                    </>
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
                  placeholder="WayinVideo AI will write a viral hook from your video..."
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
                {/* WayinVideo-powered caption button */}
                <Pressable
                  style={({ pressed }) => [styles.wayinAiBtn, pressed && { opacity: 0.85 }, generatingCaption && styles.aiBtnLoading]}
                  onPress={handleGenerateCaption}
                  disabled={generatingCaption || isWayinRunning}
                >
                  {generatingCaption ? (
                    <><ActivityIndicator size="small" color="#fff" /><Text style={styles.wayinAiBtnText}>Analyzing video...</Text></>
                  ) : (
                    <>
                      <MaterialCommunityIcons name="lightning-bolt" size={16} color="#fff" />
                      <Text style={styles.wayinAiBtnText}>{caption ? 'Regenerate Caption & Hashtags' : 'AI Write Caption & Hashtags'}</Text>
                      <View style={styles.wayinBadge}><Text style={styles.wayinBadgeText}>WayinVideo</Text></View>
                    </>
                  )}
                </Pressable>

                <Text style={styles.sectionLabel}>Caption</Text>
                <TextInput
                  style={[styles.textInput, { minHeight: 100 }]}
                  value={caption}
                  onChangeText={setCaption}
                  placeholder="WayinVideo AI will write your caption from the video..."
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

            {/* ── Audio Tab (still Gemini) ── */}
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
            onPress={() => { if (!isWayinRunning) closeWayinSheet(); }}
          />
          <View style={[styles.tiktokSheet, { maxHeight: '85%' }]}>
            <View style={styles.sheetHandle} />

            <View style={styles.sheetHeader}>
              <View style={[styles.sheetIcon, { backgroundColor: '#6c47ff' }]}>
                <MaterialCommunityIcons name="lightning-bolt" size={22} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>WayinVideo AI</Text>
                <Text style={styles.sheetSub}>
                  {wayinTarget === 'hook' ? 'Hook generation from video analysis'
                    : wayinTarget === 'caption' ? 'Caption & hashtag generation'
                    : 'Viral clip detection & trim'}
                </Text>
              </View>
              {!isWayinRunning ? (
                <Pressable onPress={closeWayinSheet} hitSlop={8}>
                  <MaterialIcons name="close" size={20} color={Colors.textMuted} />
                </Pressable>
              ) : null}
            </View>

            {isWayinRunning ? (
              <View style={styles.sheetPhase}>
                <ActivityIndicator size="large" color="#6c47ff" />
                <Text style={styles.sheetPhaseTitle}>
                  {wayinPhase === 'uploading' ? 'Uploading to WayinVideo...' : 'Analyzing your video...'}
                </Text>
                <Text style={styles.sheetPhaseSub}>
                  {wayinPhase === 'uploading'
                    ? 'Transferring your video for AI analysis...'
                    : 'Detecting viral moments and generating content. This may take up to a minute.'}
                </Text>
              </View>
            ) : null}

            {(wayinPhase === 'done' || (wayinPhase === 'analyzing' && wayinClips.length > 0) || (wayinPhase === 'idle' && wayinClips.length > 0)) ? (
              <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 480 }}>
                {wayinClips.length > 0 ? (
                  <View style={styles.wayinSuccessBanner}>
                    <MaterialIcons name="check-circle" size={16} color={Colors.emerald} />
                    <Text style={styles.wayinSuccessText}>
                      {wayinClips.length} viral clip{wayinClips.length !== 1 ? 's' : ''} detected — tap to apply or trim
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
                  onPress={() => { closeWayinSheet(); handleBrowseClips(); }}
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

                {/* ── Filmstrip ── */}
                <View style={styles.filmstripSection}>
                  <View style={styles.filmstripHeader}>
                    <MaterialIcons name="photo-library" size={13} color={Colors.textMuted} />
                    <Text style={styles.filmstripLabel}>PICK THUMBNAIL FRAME</Text>
                    {filmstripLoading ? (
                      <ActivityIndicator size="small" color="#6c47ff" style={{ marginLeft: 'auto' }} />
                    ) : filmstripFrames.length > 0 ? (
                      <Text style={styles.filmstripHint}>tap to set as thumbnail</Text>
                    ) : null}
                  </View>

                  {filmstripLoading && filmstripFrames.length === 0 ? (
                    <View style={styles.filmstripSkeleton}>
                      {[0,1,2,3,4,5].map(i => (
                        <View key={i} style={styles.filmstripSkeletonFrame} />
                      ))}
                    </View>
                  ) : filmstripFrames.length > 0 ? (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.filmstripScroll}
                    >
                      {filmstripFrames.map((frame, idx) => {
                        const isSelected = filmstripSelectedIdx === idx;
                        return (
                          <Pressable
                            key={idx}
                            style={({ pressed }) => [
                              styles.filmstripFrame,
                              isSelected && styles.filmstripFrameSelected,
                              pressed && { opacity: 0.82 },
                            ]}
                            onPress={() => {
                              setFilmstripSelectedIdx(idx);
                              setThumbnailUri(frame.uri);
                              if (video) updateVideo(video.id, { thumbnail: frame.uri });
                            }}
                          >
                            <Image
                              source={{ uri: frame.uri }}
                              style={styles.filmstripImg}
                              contentFit="cover"
                              transition={150}
                            />
                            <View style={styles.filmstripTs}>
                              <Text style={styles.filmstripTsText}>{formatTimestamp(frame.ts)}</Text>
                            </View>
                            {isSelected ? (
                              <View style={styles.filmstripSelectedOverlay}>
                                <View style={styles.filmstripCheckCircle}>
                                  <MaterialIcons name="check" size={12} color="#fff" />
                                </View>
                              </View>
                            ) : null}
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                  ) : !filmstripLoading ? (
                    <View style={styles.filmstripEmpty}>
                      <MaterialIcons name="image-not-supported" size={18} color={Colors.textMuted} />
                      <Text style={styles.filmstripEmptyText}>Frame extraction not available on this device</Text>
                    </View>
                  ) : null}
                </View>

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
                    <Text style={styles.clipMetaLabel}>HOOK / TITLE</Text>
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

                {/* Set as Thumbnail */}
                {(selectedWayinClip.start >= 0) ? (
                  <Pressable
                    style={({ pressed }) => [styles.clipThumbBtn, pressed && { opacity: 0.85 }, generatingThumbnail && { opacity: 0.6 }]}
                    onPress={() => {
                      if (!video?.videoUri) return;
                      generateWayinThumbnail(selectedWayinClip, wayinPublicUrlRef.current ?? video.videoUri);
                    }}
                    disabled={generatingThumbnail}
                  >
                    {generatingThumbnail ? (
                      <><ActivityIndicator size="small" color="#6c47ff" /><Text style={styles.clipThumbBtnText}>Generating thumbnail...</Text></>
                    ) : (
                      <><MaterialIcons name="photo-camera" size={16} color="#6c47ff" /><Text style={styles.clipThumbBtnText}>Use Clip Frame as Thumbnail</Text>{thumbnailUri ? <View style={styles.thumbPreviewDot}><MaterialIcons name="check" size={10} color="#fff" /></View> : null}</>
                    )}
                  </Pressable>
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
                  <Text style={styles.clipActionBtnOutlineText}>Apply Hook, Caption & Hashtags (no trim)</Text>
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
                  Hook, caption and hashtags applied from WayinVideo. Ready to publish!
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

  // Clips available banner
  clipsBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#6c47ff18', borderRadius: Radius.md, marginHorizontal: Spacing.md,
    marginBottom: Spacing.sm, paddingHorizontal: Spacing.sm + 2, paddingVertical: 8,
    borderWidth: 1, borderColor: '#6c47ff33',
  },
  clipsBannerText: { flex: 1, fontSize: FontSize.sm, color: '#6c47ff', fontWeight: FontWeight.semibold, includeFontPadding: false },

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

  // WayinVideo-powered AI button (purple, solid)
  wayinAiBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#6c47ff', borderRadius: Radius.full, paddingVertical: 13, minHeight: 48,
  },
  wayinAiBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  wayinBadge: {
    backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: Radius.full,
    paddingHorizontal: 7, paddingVertical: 2,
  },
  wayinBadgeText: { fontSize: 9, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },

  // Gemini AI button (outline, accent)
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
  clipThumbBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: Radius.full, paddingVertical: 11, borderWidth: 1.5, borderColor: '#6c47ff',
    backgroundColor: '#6c47ff18', marginBottom: Spacing.sm,
  },
  clipThumbBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: '#6c47ff', includeFontPadding: false },
  thumbPreviewDot: {
    width: 16, height: 16, borderRadius: 8, backgroundColor: Colors.emerald,
    alignItems: 'center', justifyContent: 'center',
  },
  thumbRefreshBtn: {
    position: 'absolute', top: 8, right: 8,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.65)', alignItems: 'center', justifyContent: 'center',
  },

  // Filmstrip
  filmstripSection: {
    marginBottom: Spacing.md,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: '#6c47ff33',
    overflow: 'hidden',
    paddingVertical: Spacing.sm,
  },
  filmstripHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: Spacing.sm + 4, marginBottom: Spacing.xs,
  },
  filmstripLabel: {
    fontSize: 9, fontWeight: FontWeight.bold, color: Colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.9, includeFontPadding: false,
  },
  filmstripHint: {
    marginLeft: 'auto' as any, fontSize: 9, color: '#6c47ff',
    fontWeight: FontWeight.semibold, includeFontPadding: false,
  },
  filmstripScroll: {
    flexDirection: 'row', gap: 6,
    paddingHorizontal: Spacing.sm + 4, paddingBottom: 2,
  },
  filmstripFrame: {
    width: 72, height: 100, borderRadius: Radius.md,
    overflow: 'hidden', borderWidth: 2.5, borderColor: 'transparent',
    position: 'relative',
  },
  filmstripFrameSelected: {
    borderColor: '#6c47ff',
  },
  filmstripImg: { width: '100%', height: '100%' },
  filmstripTs: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.68)',
    paddingVertical: 3, alignItems: 'center',
  },
  filmstripTsText: { fontSize: 9, color: '#fff', fontWeight: FontWeight.semibold, includeFontPadding: false },
  filmstripSelectedOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(108,71,255,0.22)',
    alignItems: 'flex-start', justifyContent: 'flex-start',
    padding: 4,
  },
  filmstripCheckCircle: {
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: '#6c47ff', alignItems: 'center', justifyContent: 'center',
  },
  filmstripSkeleton: {
    flexDirection: 'row', gap: 6,
    paddingHorizontal: Spacing.sm + 4, paddingBottom: 2,
  },
  filmstripSkeletonFrame: {
    width: 72, height: 100, borderRadius: Radius.md,
    backgroundColor: Colors.surfaceBorder,
  },
  filmstripEmpty: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.sm + 4, paddingVertical: Spacing.xs,
  },
  filmstripEmptyText: { fontSize: FontSize.xs, color: Colors.textMuted, flex: 1, includeFontPadding: false },

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
