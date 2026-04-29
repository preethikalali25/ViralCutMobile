import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useVideos } from '@/hooks/useVideos';
import { useAlert, getSupabaseClient } from '@/template';
import { MOCK_TRENDING_AUDIO } from '@/constants/mockData';
import { Platform as PlatformType, HookType } from '@/types';
import PlatformBadge from '@/components/ui/PlatformBadge';
import StatusBadge from '@/components/ui/StatusBadge';
import { formatDuration } from '@/services/formatters';
import { FunctionsHttpError } from '@supabase/supabase-js';

type Tab = 'hook' | 'caption' | 'audio' | 'platforms';

interface AISuggestedAudio {
  id: string;
  title: string;
  artist: string;
  uses: string;
  trending: boolean;
  platform: string[];
  mood: string;
}

const HOOK_TYPES: { type: HookType; label: string; desc: string; icon: string }[] = [
  { type: 'question', label: 'Question', desc: 'Curiosity hook', icon: 'help-outline' },
  { type: 'stat', label: 'Stat', desc: 'Shocking number', icon: 'bar-chart' },
  { type: 'visual', label: 'Visual', desc: 'Visual surprise', icon: 'visibility' },
];

const ALL_PLATFORMS: PlatformType[] = ['tiktok', 'reels', 'youtube'];

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

  const video = videos.find(v => v.id === id) ?? videos.find(v => v.status === 'ready' || v.status === 'published');

  const [tab, setTab] = useState<Tab>('hook');
  const [hookType, setHookType] = useState<HookType>(video?.hook?.type ?? 'question');
  const [hookText, setHookText] = useState(video?.hook?.text ?? '');
  const [caption, setCaption] = useState(video?.caption ?? '');
  const [hashtags, setHashtags] = useState(video?.hashtags?.join(' ') ?? '');
  const [selectedAudioId, setSelectedAudioId] = useState(video?.audio?.id ?? '');
  const [platforms, setPlatforms] = useState<PlatformType[]>(video?.platforms ?? ['tiktok']);

  // AI states
  const [generatingHook, setGeneratingHook] = useState(false);
  const [generatingCaption, setGeneratingCaption] = useState(false);
  const [generatingAudio, setGeneratingAudio] = useState(false);
  const [aiAudioList, setAiAudioList] = useState<AISuggestedAudio[]>([]);
  const [hookSuggestions, setHookSuggestions] = useState<string[]>([]);
  const [showHookSuggestions, setShowHookSuggestions] = useState(false);

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

  // AI: Generate Hook
  const handleGenerateHook = useCallback(async () => {
    setGeneratingHook(true);
    setShowHookSuggestions(false);
    // Generate 3 hook variations
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { data, error } = await callAIGenerator('hook', {
        videoTitle: video.title,
        hookType,
        platforms,
      });
      if (error) {
        showAlert('AI Error', error);
        setGeneratingHook(false);
        return;
      }
      if (data?.result) results.push(data.result);
    }
    setHookSuggestions(results);
    setShowHookSuggestions(true);
    setGeneratingHook(false);
  }, [video.title, hookType, platforms, showAlert]);

  // AI: Generate Caption
  const handleGenerateCaption = useCallback(async () => {
    setGeneratingCaption(true);
    const { data, error } = await callAIGenerator('caption', {
      videoTitle: video.title,
      platforms,
    });
    setGeneratingCaption(false);
    if (error) { showAlert('AI Error', error); return; }
    if (data?.result) {
      if (data.result.caption) setCaption(data.result.caption);
      if (data.result.hashtags) setHashtags(data.result.hashtags);
    }
  }, [video.title, platforms, showAlert]);

  // AI: Suggest Audio
  const handleGenerateAudio = useCallback(async () => {
    setGeneratingAudio(true);
    const { data, error } = await callAIGenerator('audio', {
      videoTitle: video.title,
      platforms,
    });
    setGeneratingAudio(false);
    if (error) { showAlert('AI Error', error); return; }
    if (Array.isArray(data?.result)) {
      setAiAudioList(data.result);
      setSelectedAudioId('');
    }
  }, [video.title, platforms, showAlert]);

  const handleSave = () => {
    if (!video) return;
    const audioSource = aiAudioList.length > 0
      ? aiAudioList.find(a => a.id === selectedAudioId)
      : MOCK_TRENDING_AUDIO.find(a => a.id === selectedAudioId);
    updateVideo(video.id, {
      hook: { type: hookType, text: hookText },
      caption,
      hashtags: hashtags.split(/\s+/).filter(Boolean),
      audio: audioSource ? { id: audioSource.id, title: audioSource.title, artist: audioSource.artist, uses: audioSource.uses, trending: audioSource.trending } : undefined,
      platforms,
    });
    showAlert('Saved', 'Your changes have been saved.');
  };

  const handleSchedule = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(12, 0, 0, 0);
    updateVideo(video.id, {
      status: 'scheduled',
      scheduledAt: tomorrow.toISOString(),
      hook: { type: hookType, text: hookText },
      caption,
      hashtags: hashtags.split(/\s+/).filter(Boolean),
      platforms,
    });
    showAlert('Scheduled!', 'Your video is scheduled for tomorrow at 12:00 PM.', [
      { text: 'View Schedule', onPress: () => router.push('/(tabs)/schedule') },
      { text: 'OK', style: 'cancel' },
    ]);
  };

  const handlePublish = () => {
    showAlert('Publish Now?', 'This will publish your video immediately.', [
      {
        text: 'Publish', onPress: () => {
          updateVideo(video.id, {
            status: 'published',
            publishedAt: new Date().toISOString(),
            hook: { type: hookType, text: hookText },
            caption,
            hashtags: hashtags.split(/\s+/).filter(Boolean),
            platforms,
          });
          router.push('/(tabs)/library');
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const togglePlatform = (p: PlatformType) => {
    setPlatforms(prev =>
      prev.includes(p) ? (prev.length > 1 ? prev.filter(x => x !== p) : prev) : [...prev, p]
    );
  };

  const audioDisplayList = aiAudioList.length > 0 ? aiAudioList : MOCK_TRENDING_AUDIO;

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
            <Text style={styles.headerTitle} numberOfLines={1}>{video.title}</Text>
            <View style={styles.headerMeta}>
              <StatusBadge status={video.status} />
              <Text style={styles.duration}>{formatDuration(video.duration)}</Text>
            </View>
          </View>
          <Pressable
            style={({ pressed }) => [styles.saveBtn, pressed && { opacity: 0.8 }]}
            onPress={handleSave}
          >
            <Text style={styles.saveBtnText}>Save</Text>
          </Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false}>
          {/* Thumbnail Preview */}
          <View style={styles.previewContainer}>
            <View style={styles.preview}>
              <Image source={{ uri: video.thumbnail }} style={styles.previewImg} contentFit="cover" transition={200} />
              {hookText ? (
                <View style={styles.hookOverlay}>
                  <Text style={styles.hookOverlayText}>{hookText}</Text>
                </View>
              ) : null}
              <View style={styles.playBtn}>
                <MaterialIcons name="play-circle-filled" size={44} color="rgba(255,255,255,0.9)" />
              </View>
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

          {/* Tab Content */}
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
                      onPress={() => { setHookType(h.type); setShowHookSuggestions(false); }}
                    >
                      <MaterialIcons
                        name={h.icon as any}
                        size={20}
                        color={hookType === h.type ? Colors.primaryLight : Colors.textSecondary}
                      />
                      <Text style={[styles.hookTypeLabel, hookType === h.type && styles.hookTypeLabelActive]}>
                        {h.label}
                      </Text>
                      <Text style={styles.hookTypeDesc}>{h.desc}</Text>
                    </Pressable>
                  ))}
                </View>

                {/* AI Generate Hook Button */}
                <Pressable
                  style={({ pressed }) => [styles.aiBtn, pressed && { opacity: 0.85 }, generatingHook && styles.aiBtnLoading]}
                  onPress={handleGenerateHook}
                  disabled={generatingHook}
                >
                  {generatingHook ? (
                    <>
                      <ActivityIndicator size="small" color={Colors.primaryLight} />
                      <Text style={styles.aiBtnText}>Generating hooks...</Text>
                    </>
                  ) : (
                    <>
                      <MaterialCommunityIcons name="auto-fix" size={16} color={Colors.primaryLight} />
                      <Text style={styles.aiBtnText}>AI Generate Hook</Text>
                    </>
                  )}
                </Pressable>

                {/* Hook Suggestions */}
                {showHookSuggestions && hookSuggestions.length > 0 ? (
                  <View style={styles.suggestionsBox}>
                    <Text style={styles.suggestionsTitle}>Tap to use</Text>
                    {hookSuggestions.map((s, i) => (
                      <Pressable
                        key={i}
                        style={({ pressed }) => [styles.suggestionCard, pressed && { opacity: 0.8 }]}
                        onPress={() => { setHookText(s); setShowHookSuggestions(false); }}
                      >
                        <MaterialCommunityIcons name="lightning-bolt" size={14} color={Colors.amber} />
                        <Text style={styles.suggestionText}>{s}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}

                <Text style={[styles.sectionLabel, { marginTop: Spacing.sm }]}>Hook Text</Text>
                <TextInput
                  style={styles.textInput}
                  value={hookText}
                  onChangeText={setHookText}
                  placeholder="Write a compelling hook or generate with AI..."
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
                {/* AI Generate Caption Button */}
                <Pressable
                  style={({ pressed }) => [styles.aiBtn, pressed && { opacity: 0.85 }, generatingCaption && styles.aiBtnLoading]}
                  onPress={handleGenerateCaption}
                  disabled={generatingCaption}
                >
                  {generatingCaption ? (
                    <>
                      <ActivityIndicator size="small" color={Colors.primaryLight} />
                      <Text style={styles.aiBtnText}>Writing caption...</Text>
                    </>
                  ) : (
                    <>
                      <MaterialCommunityIcons name="auto-fix" size={16} color={Colors.primaryLight} />
                      <Text style={styles.aiBtnText}>AI Generate Caption & Hashtags</Text>
                    </>
                  )}
                </Pressable>

                <Text style={styles.sectionLabel}>Caption</Text>
                <TextInput
                  style={[styles.textInput, { minHeight: 100 }]}
                  value={caption}
                  onChangeText={setCaption}
                  placeholder="Write your caption or generate with AI..."
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
                    <Pressable
                      key={tag}
                      style={styles.tagChip}
                      onPress={() => setHashtags(prev => prev ? `${prev} ${tag}` : tag)}
                    >
                      <Text style={styles.tagChipText}>{tag}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}

            {/* ── Audio Tab ── */}
            {tab === 'audio' ? (
              <View style={styles.section}>
                {/* AI Suggest Audio Button */}
                <Pressable
                  style={({ pressed }) => [styles.aiBtn, pressed && { opacity: 0.85 }, generatingAudio && styles.aiBtnLoading]}
                  onPress={handleGenerateAudio}
                  disabled={generatingAudio}
                >
                  {generatingAudio ? (
                    <>
                      <ActivityIndicator size="small" color={Colors.primaryLight} />
                      <Text style={styles.aiBtnText}>Finding trending songs...</Text>
                    </>
                  ) : (
                    <>
                      <MaterialCommunityIcons name="auto-fix" size={16} color={Colors.primaryLight} />
                      <Text style={styles.aiBtnText}>AI Suggest Trending Songs</Text>
                    </>
                  )}
                </Pressable>

                <View style={styles.audioHeader}>
                  <Text style={styles.sectionLabel}>
                    {aiAudioList.length > 0 ? 'AI Recommended for Your Video' : 'Trending Audio'}
                  </Text>
                  {aiAudioList.length > 0 ? (
                    <Pressable onPress={() => { setAiAudioList([]); setSelectedAudioId(video.audio?.id ?? ''); }}>
                      <Text style={styles.resetLink}>Reset</Text>
                    </Pressable>
                  ) : null}
                </View>

                {audioDisplayList.map(audio => (
                  <Pressable
                    key={audio.id}
                    style={[styles.audioRow, selectedAudioId === audio.id && styles.audioRowActive]}
                    onPress={() => setSelectedAudioId(audio.id)}
                  >
                    <View style={[styles.audioIcon, selectedAudioId === audio.id && { backgroundColor: Colors.primary }]}>
                      <MaterialIcons name="music-note" size={18} color={selectedAudioId === audio.id ? '#fff' : Colors.textSecondary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.audioTitle}>{audio.title}</Text>
                      <Text style={styles.audioArtist}>{audio.artist}</Text>
                      {'mood' in audio && audio.mood ? (
                        <Text style={styles.audioMoodTag}>{(audio as AISuggestedAudio).mood}</Text>
                      ) : null}
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
                    {selectedAudioId === audio.id ? (
                      <MaterialIcons name="check-circle" size={20} color={Colors.primary} />
                    ) : null}
                  </Pressable>
                ))}
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
            <Pressable
              style={({ pressed }) => [styles.scheduleBtn, pressed && { opacity: 0.8 }]}
              onPress={handleSchedule}
            >
              <MaterialIcons name="schedule" size={18} color={Colors.primaryLight} />
              <Text style={styles.scheduleBtnText}>Schedule</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.publishBtn, pressed && { opacity: 0.8 }]}
              onPress={handlePublish}
            >
              <MaterialIcons name="send" size={18} color="#fff" />
              <Text style={styles.publishBtnText}>Publish Now</Text>
            </Pressable>
          </View>

          <View style={{ height: Spacing.xl }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 4,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    backgroundColor: Colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  headerTitle: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  headerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: 4,
  },
  duration: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    includeFontPadding: false,
  },
  saveBtn: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.full,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  saveBtnText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  previewContainer: {
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  preview: {
    width: 140,
    height: 200,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: Colors.surface,
  },
  previewImg: { width: '100%', height: '100%' },
  hookOverlay: {
    position: 'absolute',
    bottom: 16,
    left: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: Radius.sm,
    padding: 6,
  },
  hookOverlayText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: '#fff',
    textAlign: 'center',
    includeFontPadding: false,
  },
  playBtn: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: Spacing.md,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.full,
    padding: 4,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: Radius.full,
  },
  tabBtnActive: { backgroundColor: Colors.primary },
  tabLabel: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  tabLabelActive: { color: '#fff' },
  tabContent: { paddingTop: Spacing.md },
  section: {
    paddingHorizontal: Spacing.md,
    gap: Spacing.sm,
  },
  sectionLabel: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },

  // AI Button
  aiBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primaryGlow,
    borderRadius: Radius.full,
    paddingVertical: 12,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    minHeight: 46,
  },
  aiBtnLoading: {
    opacity: 0.7,
  },
  aiBtnText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.primaryLight,
    includeFontPadding: false,
  },

  // Hook Suggestions
  suggestionsBox: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    padding: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.primary + '44',
    gap: Spacing.xs,
  },
  suggestionsTitle: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 2,
    includeFontPadding: false,
  },
  suggestionCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.sm + 2,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  suggestionText: {
    flex: 1,
    fontSize: FontSize.sm,
    color: Colors.textPrimary,
    fontWeight: FontWeight.medium,
    lineHeight: 19,
    includeFontPadding: false,
  },

  // Hook Types
  hookTypes: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  hookTypeCard: {
    flex: 1,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    alignItems: 'center',
    gap: 4,
    borderWidth: 1.5,
    borderColor: Colors.surfaceBorder,
  },
  hookTypeCardActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryGlow,
  },
  hookTypeLabel: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  hookTypeLabelActive: { color: Colors.primaryLight },
  hookTypeDesc: {
    fontSize: 10,
    color: Colors.textMuted,
    textAlign: 'center',
    includeFontPadding: false,
  },

  // Text Input
  textInput: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.sm + 4,
    fontSize: FontSize.md,
    color: Colors.textPrimary,
    textAlignVertical: 'top',
    minHeight: 80,
    includeFontPadding: false,
  },
  charCount: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textAlign: 'right',
    includeFontPadding: false,
  },

  // Hashtags
  suggestedTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: 4,
  },
  tagChip: {
    backgroundColor: Colors.primaryGlow,
    borderRadius: Radius.full,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: Colors.primary + '44',
  },
  tagChipText: {
    fontSize: FontSize.sm,
    color: Colors.primaryLight,
    fontWeight: FontWeight.semibold,
    includeFontPadding: false,
  },

  // Audio
  audioHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  resetLink: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    fontWeight: FontWeight.semibold,
    includeFontPadding: false,
  },
  audioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    padding: Spacing.sm + 4,
    borderWidth: 1.5,
    borderColor: Colors.surfaceBorder,
  },
  audioRowActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryGlow,
  },
  audioIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    backgroundColor: Colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioTitle: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  audioArtist: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  audioMoodTag: {
    fontSize: 10,
    color: Colors.primaryLight,
    fontWeight: FontWeight.medium,
    marginTop: 2,
    includeFontPadding: false,
    textTransform: 'capitalize',
  },
  audioMeta: {
    alignItems: 'flex-end',
    gap: 3,
  },
  trendingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: Colors.primaryGlow,
    borderRadius: Radius.full,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  trendingText: {
    fontSize: 10,
    color: Colors.primaryLight,
    fontWeight: FontWeight.bold,
    includeFontPadding: false,
  },
  audioUses: {
    fontSize: 10,
    color: Colors.textMuted,
    includeFontPadding: false,
  },

  // Platforms
  platformRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    padding: Spacing.sm + 4,
    borderWidth: 1.5,
    borderColor: Colors.surfaceBorder,
  },
  platformRowActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryGlow,
  },
  platformLabel: {
    flex: 1,
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: Radius.sm,
    borderWidth: 2,
    borderColor: Colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },

  // Actions
  actions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.lg,
  },
  scheduleBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.full,
    paddingVertical: 14,
    borderWidth: 1.5,
    borderColor: Colors.primary,
  },
  scheduleBtnText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: Colors.primaryLight,
    includeFontPadding: false,
  },
  publishBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    borderRadius: Radius.full,
    paddingVertical: 14,
  },
  publishBtnText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: '#fff',
    includeFontPadding: false,
  },
  emptyTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  uploadBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: Radius.full,
  },
  uploadBtnText: {
    color: '#fff',
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    includeFontPadding: false,
  },
});
