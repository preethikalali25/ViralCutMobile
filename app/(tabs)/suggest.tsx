import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable,
  FlatList, ActivityIndicator, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as MediaLibrary from 'expo-media-library';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useAuth, getSupabaseClient } from '@/template';
import { useInstagram } from '@/hooks/useInstagram';
import { setPendingReelItems, PendingReelItem } from '@/stores/pendingReel';

const { width } = Dimensions.get('window');
const GAP = 3;
const COLS = 3;
const THUMB = (width - Spacing.md * 2 - GAP * (COLS - 1)) / COLS;

type GalleryItem = {
  id: string;
  uri: string;
  type: 'photo' | 'video';
  durationSec?: number;
  previewUri: string;
  base64?: string;
};

type Suggestion = {
  id: string;
  title: string;
  hook: string;
  reason: string;
  galleryIndices: number[];
  contentType: 'photo_montage' | 'video_clip' | 'mixed';
};

type AnalysisResult = {
  profile: { username: string; followers: number; bio: string };
  suggestions: Suggestion[];
};

const CONTENT_TYPE_LABEL: Record<string, string> = {
  photo_montage: 'Photo Montage',
  video_clip: 'Video Clip',
  mixed: 'Mixed',
};

export default function SuggestScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { status: igStatus } = useInstagram();

  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [galleryPermission, setGalleryPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [loadingGallery, setLoadingGallery] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeStep, setAnalyzeStep] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadGallery = useCallback(async () => {
    setLoadingGallery(true);
    const { granted } = await MediaLibrary.requestPermissionsAsync();
    if (!granted) {
      setGalleryPermission('denied');
      setLoadingGallery(false);
      return;
    }
    setGalleryPermission('granted');

    const { assets } = await MediaLibrary.getAssetsAsync({
      mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
      sortBy: [MediaLibrary.SortBy.creationTime],
      first: 20,
    });

    const items: GalleryItem[] = assets.map(a => ({
      id: a.id,
      uri: a.uri,
      type: a.mediaType === MediaLibrary.MediaType.video ? 'video' : 'photo',
      durationSec: a.duration ? Math.round(a.duration) : undefined,
      previewUri: a.uri,
    }));

    setGalleryItems(items);
    setLoadingGallery(false);
  }, []);

  useEffect(() => { loadGallery(); }, [loadGallery]);

  const genThumb = async (item: GalleryItem): Promise<{ previewUri: string; base64: string } | null> => {
    try {
      let src = item.uri;
      if (item.type === 'video') {
        const { uri } = await VideoThumbnails.getThumbnailAsync(item.uri, { time: 500 });
        src = uri;
      }
      const r = await ImageManipulator.manipulateAsync(
        src,
        [{ resize: { width: 128 } }],
        { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      return { previewUri: r.uri, base64: r.base64 ?? '' };
    } catch {
      return null;
    }
  };

  const handleAnalyze = async () => {
    if (!user?.id) return;
    if (!igStatus.connected) {
      setError('Connect your Instagram account first — go to the Profile tab and tap "Connect Instagram".');
      return;
    }
    if (galleryItems.length === 0) {
      setError('No gallery items found. Allow media library access and try again.');
      return;
    }

    setAnalyzing(true);
    setError(null);
    setResult(null);

    // Generate thumbnails for first 8 items (sent to AI) + previews for rest
    setAnalyzeStep('Reading your gallery…');
    const updated = [...galleryItems];
    const thumbnails: Array<{ id: string; type: 'photo' | 'video'; base64: string }> = [];

    const limit = Math.min(galleryItems.length, 8);
    for (let i = 0; i < limit; i++) {
      const item = galleryItems[i];
      const thumb = await genThumb(item);
      if (thumb) {
        updated[i] = { ...item, previewUri: thumb.previewUri, base64: thumb.base64 };
        thumbnails.push({ id: item.id, type: item.type, base64: thumb.base64 });
      }
    }
    // Generate previews for items 8-19 too (display only)
    for (let i = limit; i < galleryItems.length; i++) {
      const item = galleryItems[i];
      const thumb = await genThumb(item);
      if (thumb) updated[i] = { ...item, previewUri: thumb.previewUri };
    }
    setGalleryItems(updated);

    setAnalyzeStep('Analysing your Instagram profile…');
    const supabase = getSupabaseClient();
    const { data, error: fnErr } = await supabase.functions.invoke('content-advisor', {
      body: { userId: user.id, galleryThumbnails: thumbnails },
    });

    if (fnErr) {
      let msg = fnErr.message ?? 'Analysis failed. Please try again.';
      if (fnErr instanceof FunctionsHttpError) {
        try { msg = (await fnErr.context?.text()) ?? msg; } catch { /* ignore */ }
      }
      setError(msg);
      setAnalyzing(false);
      setAnalyzeStep('');
      return;
    }

    setResult(data as AnalysisResult);
    setAnalyzing(false);
    setAnalyzeStep('');
  };

  const handleMakeReel = (suggestion: Suggestion) => {
    const indices = suggestion.galleryIndices ?? [];
    const items: PendingReelItem[] = indices
      .map(i => galleryItems[i])
      .filter(Boolean)
      .map(g => ({
        uri: g.uri,
        type: g.type,
        previewUri: g.previewUri,
        durationSec: g.durationSec,
      }));

    if (items.length > 0) setPendingReelItems(items);
    router.push('/upload');
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Reel Ideas</Text>
          <Text style={styles.headerSub}>AI-powered suggestions from your gallery</Text>
        </View>
        <Pressable style={styles.refreshBtn} onPress={loadGallery}>
          <MaterialIcons name="refresh" size={20} color={Colors.textSecondary} />
        </Pressable>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

        {/* Instagram status banner */}
        {!igStatus.connected && (
          <Pressable style={styles.igBanner} onPress={() => router.push('/profile')}>
            <MaterialCommunityIcons name="instagram" size={18} color={Colors.rose} />
            <Text style={styles.igBannerText}>Connect Instagram to get personalised suggestions</Text>
            <MaterialIcons name="chevron-right" size={16} color={Colors.rose} />
          </Pressable>
        )}

        {igStatus.connected && igStatus.username && (
          <View style={styles.igConnected}>
            <MaterialCommunityIcons name="instagram" size={16} color={Colors.emerald} />
            <Text style={styles.igConnectedText}>@{igStatus.username}</Text>
            {igStatus.followersCount != null && (
              <Text style={styles.igFollowers}>· {igStatus.followersCount.toLocaleString()} followers</Text>
            )}
          </View>
        )}

        {/* Gallery grid */}
        <Text style={styles.sectionLabel}>Your Recent Media</Text>

        {galleryPermission === 'denied' && (
          <View style={styles.permissionBox}>
            <MaterialIcons name="photo-library" size={36} color={Colors.textMuted} />
            <Text style={styles.permissionTitle}>Media Access Required</Text>
            <Text style={styles.permissionSub}>Allow access to your photo library to see gallery suggestions.</Text>
            <Pressable style={styles.permissionBtn} onPress={loadGallery}>
              <Text style={styles.permissionBtnText}>Allow Access</Text>
            </Pressable>
          </View>
        )}

        {galleryPermission !== 'denied' && (
          <>
            {loadingGallery ? (
              <View style={styles.galleryLoading}>
                <ActivityIndicator color={Colors.primary} />
                <Text style={styles.galleryLoadingText}>Loading gallery…</Text>
              </View>
            ) : (
              <>
                {galleryItems.length === 0 ? (
                  <View style={styles.galleryEmpty}>
                    <MaterialIcons name="photo-library" size={32} color={Colors.textMuted} />
                    <Text style={styles.galleryEmptyText}>No media found</Text>
                  </View>
                ) : (
                  <View style={styles.grid}>
                    {galleryItems.map((item, idx) => (
                      <View key={item.id} style={styles.gridCell}>
                        <Image
                          source={{ uri: item.previewUri }}
                          style={styles.gridThumb}
                          contentFit="cover"
                          transition={150}
                        />
                        {item.type === 'video' && (
                          <View style={styles.videoTag}>
                            <MaterialIcons name="videocam" size={9} color="#fff" />
                            {item.durationSec != null && (
                              <Text style={styles.videoTagText}>{Math.min(item.durationSec, 60)}s</Text>
                            )}
                          </View>
                        )}
                        {idx < 8 && (
                          <View style={styles.aiChip}>
                            <Text style={styles.aiChipText}>{idx}</Text>
                          </View>
                        )}
                      </View>
                    ))}
                  </View>
                )}
                <Text style={styles.aiNote}>
                  Items labelled 0–{Math.min(galleryItems.length, 8) - 1} are shown to the AI for analysis
                </Text>
              </>
            )}
          </>
        )}

        {/* Analyse button */}
        {galleryPermission === 'granted' && !loadingGallery && (
          <Pressable
            style={({ pressed }) => [
              styles.analyzeBtn,
              (analyzing || galleryItems.length === 0) && styles.analyzeBtnDisabled,
              pressed && { opacity: 0.85 },
            ]}
            onPress={handleAnalyze}
            disabled={analyzing || galleryItems.length === 0}
          >
            {analyzing ? (
              <View style={styles.analyzingRow}>
                <ActivityIndicator size="small" color={Colors.primaryLight} />
                <Text style={styles.analyzeBtnText}>{analyzeStep || 'Analysing…'}</Text>
              </View>
            ) : (
              <>
                <MaterialCommunityIcons name="magic-staff" size={18} color={Colors.primaryLight} />
                <Text style={styles.analyzeBtnText}>Analyse My Profile</Text>
              </>
            )}
          </Pressable>
        )}

        {/* Error */}
        {error != null && (
          <View style={styles.errorBox}>
            <MaterialIcons name="error-outline" size={16} color={Colors.rose} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Suggestions */}
        {result != null && (
          <View style={styles.suggestionsSection}>
            <View style={styles.suggestionsHeader}>
              <MaterialCommunityIcons name="creation" size={16} color={Colors.violet} />
              <Text style={styles.suggestionsTitle}>3 Reel Ideas for You</Text>
            </View>

            {result.suggestions.map((s, i) => (
              <View key={s.id ?? i} style={styles.card}>
                {/* Card header */}
                <View style={styles.cardHeader}>
                  <View style={styles.cardRank}>
                    <Text style={styles.cardRankText}>{i + 1}</Text>
                  </View>
                  <Text style={styles.cardTitle} numberOfLines={2}>{s.title}</Text>
                  <View style={[
                    styles.typeBadge,
                    s.contentType === 'video_clip' && styles.typeBadgeVideo,
                    s.contentType === 'mixed' && styles.typeBadgeMixed,
                  ]}>
                    <Text style={styles.typeBadgeText}>{CONTENT_TYPE_LABEL[s.contentType] ?? s.contentType}</Text>
                  </View>
                </View>

                {/* Hook */}
                <View style={styles.hookBox}>
                  <Text style={styles.hookLabel}>HOOK</Text>
                  <Text style={styles.hookText}>"{s.hook}"</Text>
                </View>

                {/* Reason */}
                <Text style={styles.reasonText}>{s.reason}</Text>

                {/* Gallery clips used */}
                {s.galleryIndices?.length > 0 && (
                  <View style={styles.clipsRow}>
                    <Text style={styles.clipsLabel}>Uses clips:</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.clipsScroll}>
                      {s.galleryIndices.map(idx => {
                        const item = galleryItems[idx];
                        if (!item) return null;
                        return (
                          <View key={idx} style={styles.clipThumbWrap}>
                            <Image
                              source={{ uri: item.previewUri }}
                              style={styles.clipThumb}
                              contentFit="cover"
                            />
                            <View style={styles.clipIdx}>
                              <Text style={styles.clipIdxText}>{idx}</Text>
                            </View>
                          </View>
                        );
                      })}
                    </ScrollView>
                  </View>
                )}

                {/* CTA */}
                <Pressable
                  style={({ pressed }) => [styles.makeBtn, pressed && { opacity: 0.85 }]}
                  onPress={() => handleMakeReel(s)}
                >
                  <MaterialIcons name="movie-creation" size={16} color="#fff" />
                  <Text style={styles.makeBtnText}>Make This Reel</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: Spacing.xl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { paddingBottom: Spacing.xl },
  header: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.sm,
    borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder,
  },
  headerTitle: {
    fontSize: FontSize.xl, fontWeight: FontWeight.bold,
    color: Colors.textPrimary, includeFontPadding: false,
  },
  headerSub: {
    fontSize: FontSize.xs, color: Colors.textSecondary,
    includeFontPadding: false, marginTop: 2,
  },
  refreshBtn: {
    width: 36, height: 36, borderRadius: Radius.full,
    backgroundColor: Colors.surfaceElevated, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  igBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    margin: Spacing.md, backgroundColor: Colors.rose + '18',
    borderRadius: Radius.md, padding: Spacing.sm + 4,
    borderWidth: 1, borderColor: Colors.rose + '44',
  },
  igBannerText: {
    flex: 1, fontSize: FontSize.sm, color: Colors.rose,
    fontWeight: FontWeight.semibold, includeFontPadding: false,
  },
  igConnected: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginHorizontal: Spacing.md, marginTop: Spacing.sm, marginBottom: 4,
    backgroundColor: Colors.emerald + '15',
    borderRadius: Radius.md, padding: Spacing.sm + 2,
    borderWidth: 1, borderColor: Colors.emerald + '33',
  },
  igConnectedText: {
    fontSize: FontSize.sm, fontWeight: FontWeight.bold,
    color: Colors.emerald, includeFontPadding: false,
  },
  igFollowers: {
    fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false,
  },
  sectionLabel: {
    fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textSecondary,
    paddingHorizontal: Spacing.md, marginTop: Spacing.md, marginBottom: Spacing.sm,
    includeFontPadding: false,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  permissionBox: {
    marginHorizontal: Spacing.md, backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.xl, padding: Spacing.xl, alignItems: 'center',
    borderWidth: 1, borderColor: Colors.surfaceBorder, gap: Spacing.sm, marginBottom: Spacing.md,
  },
  permissionTitle: {
    fontSize: FontSize.md, fontWeight: FontWeight.bold,
    color: Colors.textPrimary, includeFontPadding: false,
  },
  permissionSub: {
    fontSize: FontSize.sm, color: Colors.textSecondary,
    textAlign: 'center', includeFontPadding: false,
  },
  permissionBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.full,
    paddingVertical: 10, paddingHorizontal: 28, marginTop: 4,
  },
  permissionBtnText: {
    color: '#fff', fontSize: FontSize.sm, fontWeight: FontWeight.bold, includeFontPadding: false,
  },
  galleryLoading: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: Spacing.md, paddingVertical: Spacing.xl, justifyContent: 'center',
  },
  galleryLoadingText: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
  galleryEmpty: {
    alignItems: 'center', gap: 8, paddingVertical: Spacing.xl, marginHorizontal: Spacing.md,
  },
  galleryEmptyText: { fontSize: FontSize.sm, color: Colors.textMuted, includeFontPadding: false },
  grid: {
    flexDirection: 'row', flexWrap: 'wrap',
    gap: GAP, paddingHorizontal: Spacing.md,
  },
  gridCell: {
    width: THUMB, height: THUMB * 1.25,
    borderRadius: Radius.sm, overflow: 'hidden',
    position: 'relative', backgroundColor: Colors.surfaceElevated,
  },
  gridThumb: { width: '100%', height: '100%' },
  videoTag: {
    position: 'absolute', bottom: 3, left: 3,
    flexDirection: 'row', alignItems: 'center', gap: 2,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3,
  },
  videoTagText: { fontSize: 8, color: '#fff', fontWeight: FontWeight.bold, includeFontPadding: false },
  aiChip: {
    position: 'absolute', top: 3, right: 3,
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  aiChipText: { fontSize: 8, color: '#fff', fontWeight: FontWeight.bold, includeFontPadding: false },
  aiNote: {
    fontSize: FontSize.xs, color: Colors.textMuted, includeFontPadding: false,
    marginHorizontal: Spacing.md, marginTop: Spacing.sm, fontStyle: 'italic',
  },
  analyzeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: Colors.primary,
    marginHorizontal: Spacing.md, marginTop: Spacing.lg,
    borderRadius: Radius.full, paddingVertical: 15,
  },
  analyzeBtnDisabled: { opacity: 0.45 },
  analyzingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  analyzeBtnText: {
    fontSize: FontSize.md, fontWeight: FontWeight.bold,
    color: '#fff', includeFontPadding: false,
  },
  errorBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    marginHorizontal: Spacing.md, marginTop: Spacing.md,
    backgroundColor: Colors.rose + '18', borderRadius: Radius.md,
    padding: Spacing.sm + 4, borderWidth: 1, borderColor: Colors.rose + '44',
  },
  errorText: {
    flex: 1, fontSize: FontSize.sm, color: Colors.rose,
    includeFontPadding: false, lineHeight: 18,
  },
  suggestionsSection: { marginTop: Spacing.lg },
  suggestionsHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.md, marginBottom: Spacing.md,
  },
  suggestionsTitle: {
    fontSize: FontSize.md, fontWeight: FontWeight.bold,
    color: Colors.violet, includeFontPadding: false,
  },
  card: {
    marginHorizontal: Spacing.md, marginBottom: Spacing.md,
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.xl,
    borderWidth: 1.5, borderColor: Colors.primary + '55',
    padding: Spacing.md, gap: Spacing.sm,
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm,
  },
  cardRank: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  cardRankText: {
    fontSize: FontSize.sm, fontWeight: FontWeight.extrabold,
    color: '#fff', includeFontPadding: false,
  },
  cardTitle: {
    flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.bold,
    color: Colors.textPrimary, includeFontPadding: false, lineHeight: 22,
  },
  typeBadge: {
    backgroundColor: Colors.sky + '22', borderRadius: Radius.sm,
    paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: Colors.sky + '55',
    flexShrink: 0,
  },
  typeBadgeVideo: { backgroundColor: Colors.violet + '22', borderColor: Colors.violet + '55' },
  typeBadgeMixed: { backgroundColor: Colors.amber + '22', borderColor: Colors.amber + '55' },
  typeBadgeText: {
    fontSize: FontSize.xs, fontWeight: FontWeight.bold,
    color: Colors.sky, includeFontPadding: false,
  },
  hookBox: {
    backgroundColor: Colors.primaryGlow, borderRadius: Radius.md,
    padding: Spacing.sm + 4, borderWidth: 1, borderColor: Colors.primary + '44',
  },
  hookLabel: {
    fontSize: 9, fontWeight: FontWeight.extrabold,
    color: Colors.primaryLight + 'aa', letterSpacing: 1,
    includeFontPadding: false, marginBottom: 4,
  },
  hookText: {
    fontSize: FontSize.sm, fontWeight: FontWeight.bold,
    color: Colors.textPrimary, includeFontPadding: false, lineHeight: 20,
  },
  reasonText: {
    fontSize: FontSize.sm, color: Colors.textSecondary,
    includeFontPadding: false, lineHeight: 19,
  },
  clipsRow: { gap: 6 },
  clipsLabel: {
    fontSize: FontSize.xs, fontWeight: FontWeight.semibold,
    color: Colors.textMuted, includeFontPadding: false,
  },
  clipsScroll: { marginTop: 2 },
  clipThumbWrap: {
    width: 52, height: 68, borderRadius: Radius.sm,
    overflow: 'hidden', marginRight: 6, position: 'relative',
    backgroundColor: Colors.surface,
  },
  clipThumb: { width: '100%', height: '100%' },
  clipIdx: {
    position: 'absolute', top: 2, right: 2,
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: 'rgba(0,0,0,0.75)', alignItems: 'center', justifyContent: 'center',
  },
  clipIdxText: { fontSize: 8, color: '#fff', fontWeight: FontWeight.bold, includeFontPadding: false },
  makeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, backgroundColor: Colors.primary,
    borderRadius: Radius.full, paddingVertical: 12, marginTop: 4,
  },
  makeBtnText: {
    fontSize: FontSize.sm, fontWeight: FontWeight.bold,
    color: '#fff', includeFontPadding: false,
  },
});
