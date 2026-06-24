import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as MediaLibrary from 'expo-media-library';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useAuth, getSupabaseClient } from '@/template';
import { Image } from 'expo-image';
import { useInstagram } from '@/hooks/useInstagram';
import { getInstagramStatus, getInstagramFullStatus, InstagramStatus } from '@/services/instagramService';
import { setPendingReelItems, PendingReelItem } from '@/stores/pendingReel';

const { width } = Dimensions.get('window');
const CARD_GAP = 10;
const CARD_W = (width - Spacing.md * 2 - CARD_GAP) / 2;
const CARD_H = CARD_W * 1.25;

const EVENT_GAP_MS = 3 * 60 * 60 * 1000;
const BATCH_SIZE = 8;      // events per analysis batch & images sent to AI
const THUMB_PRELOAD = 40;  // pre-generate thumbnails for first 40 events

type GalleryItem = {
  id: string; uri: string; type: 'photo' | 'video';
  durationSec?: number; creationTime: number;
};

type EventCluster = {
  label: string; count: number; rep: GalleryItem; base64?: string;
};

type Suggestion = {
  id: string; title: string; hook: string; reason: string;
  galleryIndices: number[]; contentType: 'photo_montage' | 'video_clip' | 'mixed';
};

type SuggestionBatch = {
  suggestions: Suggestion[];
  analysisEvents: EventCluster[];
};

type AnalysisResult = {
  niche: string;
  profile: { username?: string; followers?: number };
  batches: SuggestionBatch[];
};

const TYPE_LABEL: Record<string, string> = {
  photo_montage: 'Photo Montage',
  video_clip: 'Video Clip',
  mixed: 'Mixed',
};

const TYPE_COLOR: Record<string, string> = {
  photo_montage: Colors.sky,
  video_clip: Colors.violet,
  mixed: Colors.amber,
};

function buildEvents(items: GalleryItem[]): EventCluster[] {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => b.creationTime - a.creationTime);
  const clusters: EventCluster[] = [];
  let batch = [sorted[0]];
  const flush = () => {
    const rep = batch.find(x => x.type === 'video') ?? batch[0];
    clusters.push({
      label: new Date(batch[0].creationTime).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      }),
      count: batch.length,
      rep,
    });
  };
  for (let i = 1; i < sorted.length; i++) {
    const gap = batch[batch.length - 1].creationTime - sorted[i].creationTime;
    if (gap <= EVENT_GAP_MS) batch.push(sorted[i]);
    else { flush(); batch = [sorted[i]]; }
  }
  flush();
  return clusters;
}

async function genThumb(ev: EventCluster): Promise<string | null> {
  try {
    let src = ev.rep.uri;
    if (ev.rep.type === 'video') {
      const { uri } = await VideoThumbnails.getThumbnailAsync(src, { time: 500 });
      src = uri;
    }
    const r = await ImageManipulator.manipulateAsync(
      src, [{ resize: { width: 128 } }],
      { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    return r.base64 ?? null;
  } catch { return null; }
}

export default function SuggestScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { status: igStatus, loadingStatus: igLoading } = useInstagram();

  const [events, setEvents] = useState<EventCluster[]>([]);
  const [itemCount, setItemCount] = useState(0);
  const [thumbsReady, setThumbsReady] = useState(false);
  const itemsRef = useRef<GalleryItem[]>([]);
  const eventsRef = useRef<EventCluster[]>([]);
  const thumbsStarted = useRef(false);
  const analyzedRef = useRef(false);
  // offset for the next Load More call (advances by BATCH_SIZE each time)
  const loadMoreOffsetRef = useRef(BATCH_SIZE);
  const igProfileRef = useRef<InstagramStatus | null>(null);

  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [loading, setLoading] = useState(true);
  const [loadingStep, setLoadingStep] = useState('Scanning your gallery…');
  const [loadingMore, setLoadingMore] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveProfile, setLiveProfile] = useState<InstagramStatus | null>(null);

  useEffect(() => { eventsRef.current = events; }, [events]);

  // ── Thumbnail pre-generation ───────────────────────────────────────────────
  const generateThumbs = useCallback(async (evList: EventCluster[]) => {
    const working = [...evList];
    for (let i = 0; i < Math.min(working.length, THUMB_PRELOAD); i++) {
      const b64 = await genThumb(working[i]);
      if (b64) {
        working[i] = { ...working[i], base64: b64 };
        eventsRef.current = [...working];
        setEvents([...working]);
      }
    }
    eventsRef.current = working;
    setThumbsReady(true);
  }, []);

  // ── Gallery loading ────────────────────────────────────────────────────────
  const loadGallery = useCallback(async () => {
    setLoading(true);
    setLoadingStep('Scanning your gallery…');
    setResult(null);
    setError(null);
    setEvents([]);
    setThumbsReady(false);
    thumbsStarted.current = false;
    analyzedRef.current = false;
    loadMoreOffsetRef.current = BATCH_SIZE;
    igProfileRef.current = null;
    setLiveProfile(null);
    itemsRef.current = [];
    eventsRef.current = [];
    setItemCount(0);

    const { granted } = await MediaLibrary.requestPermissionsAsync();
    if (!granted) { setPermission('denied'); setLoading(false); return; }
    setPermission('granted');

    const toItem = (a: MediaLibrary.Asset): GalleryItem | null => {
      // Drop screenshots and screen recordings using iOS mediaSubtypes
      const subs = (a as any).mediaSubtypes as string[] | undefined;
      if (subs?.includes('screenshot') || subs?.includes('videoScreenRecording')) return null;
      return {
        id: a.id, uri: a.uri,
        type: a.mediaType === MediaLibrary.MediaType.video ? 'video' : 'photo',
        durationSec: a.duration ? Math.round(a.duration) : undefined,
        creationTime: a.creationTime,
      };
    };

    const first = await MediaLibrary.getAssetsAsync({
      mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      first: 200,
    });

    let allLoaded = first.assets.map(toItem).filter((x): x is GalleryItem => x !== null);
    itemsRef.current = allLoaded;
    setItemCount(allLoaded.length);

    const initialEvents = buildEvents(allLoaded);
    eventsRef.current = initialEvents;
    setEvents(initialEvents);
    if (!thumbsStarted.current) {
      thumbsStarted.current = true;
      generateThumbs(initialEvents);
    }

    if (first.hasNextPage) {
      let cursor: string | undefined = first.endCursor;
      while (cursor) {
        const page = await MediaLibrary.getAssetsAsync({
          mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
          sortBy: [[MediaLibrary.SortBy.creationTime, false]],
          first: 200,
          after: cursor,
        });
        allLoaded = [...allLoaded, ...page.assets.map(toItem).filter((x): x is GalleryItem => x !== null)];
        itemsRef.current = allLoaded;
        setItemCount(allLoaded.length);
        cursor = page.hasNextPage ? page.endCursor : undefined;
      }
      const finalEvents = buildEvents(allLoaded);
      const merged = finalEvents.map((ev, i) => ({ ...ev, base64: eventsRef.current[i]?.base64 }));
      eventsRef.current = merged;
      setEvents(merged);
    }
  }, [generateThumbs]);

  useEffect(() => { loadGallery(); }, [loadGallery]);

  // ── Analysis ───────────────────────────────────────────────────────────────
  const runAnalysis = useCallback(async (
    evList: EventCluster[],
    totalItems: number,
    offset: number,
    mode: 'replace' | 'append',
  ) => {
    if (!user?.id) return;

    if (mode === 'replace') {
      setLoading(true);
      setError(null);
    } else {
      setLoadingMore(true);
    }

    if (igStatus.connected && user.id && !igProfileRef.current) {
      if (mode === 'replace') setLoadingStep('Loading your Instagram profile…');
      try {
        // full=true fetches bio + recent post captions so the AI can determine niche
        const fetched = await getInstagramFullStatus(user.id);
        if (fetched.connected) {
          igProfileRef.current = fetched;
          setLiveProfile(fetched);
        }
      } catch {
        // Non-fatal — continue with basic status from useInstagram
      }
    }

    if (mode === 'replace') setLoadingStep('Analysing your niche… (~20 sec)');

    // Slice BATCH_SIZE events from offset, wrapping if needed
    const total = evList.length;
    const start = total > 0 ? offset % total : 0;
    const end = start + BATCH_SIZE;
    const topEvents = total === 0 ? [] : (end <= total
      ? evList.slice(start, end)
      : [...evList.slice(start), ...evList.slice(0, end - total)]);

    // ── Build Instagram profile section ────────────────────────────────────────
    const igProfile = igProfileRef.current;
    const igConnected = igStatus.connected;

    let profileSection: string;
    let captionsBlock = '';
    const username = igProfile?.username ?? igStatus.username;
    const followers = igProfile?.followersCount ?? igStatus.followersCount;
    if (igConnected && username) {
      profileSection = `Instagram Profile:\nUsername: @${username}\nBio: ${igProfile?.bio || 'Not set'}\nFollowers: ${followers?.toLocaleString() ?? 'unknown'}${igProfile?.mediaCount != null ? `\nTotal posts: ${igProfile.mediaCount}` : ''}`;
      if (igProfile?.recentPosts?.length) {
        const postLines = igProfile.recentPosts
          .map((p, i) => `  ${i + 1}. [${p.type}] ${p.date} | ${p.likes ?? '?'} likes | "${p.caption ?? 'no caption'}"`)
          .join('\n');
        captionsBlock = `\n\nLast ${igProfile.recentPosts.length} posts:\n${postLines}`;
      }
    } else {
      profileSection = 'Instagram: not connected.';
    }

    // Build thumbnail list for the edge function — origIdx maps back to topEvents
    // so that galleryIndices in the response are valid indices into this batch.
    const thumbnails: { origIdx: number; label: string; count: number; base64: string }[] = [];
    for (let i = 0; i < topEvents.length; i++) {
      const ev = topEvents[i];
      const b64 = ev.base64 ?? (await genThumb(ev));
      if (b64) thumbnails.push({ origIdx: i, label: ev.label, count: ev.count, base64: b64 });
    }

    try {
      const { data, error: fnError } = await getSupabaseClient().functions.invoke('analyze-gallery', {
        body: {
          profileSection,
          captionsBlock,
          thumbnails,
          totalItems,
          evCount: evList.length,
          igConnected,
        },
      });

      if (fnError || data?.error) {
        if (mode === 'replace') setError(fnError?.message ?? data?.error ?? 'AI analysis failed.');
        setLoading(false);
        setLoadingMore(false);
        return;
      }

      const suggestions: Suggestion[] = data?.suggestions ?? [];
      const newBatch: SuggestionBatch = { suggestions, analysisEvents: topEvents };

      if (mode === 'replace') {
        setResult({
          niche: data?.niche ?? '',
          profile: { username: igStatus.username, followers: igStatus.followersCount },
          batches: [newBatch],
        });
      } else {
        setResult(prev => prev
          ? { ...prev, batches: [...prev.batches, newBatch] }
          : { niche: data?.niche ?? '', profile: {}, batches: [newBatch] },
        );
      }
    } catch (err) {
      if (mode === 'replace') setError(`Error: ${String(err)}`);
    }

    setLoading(false);
    setLoadingMore(false);
  }, [user?.id, igStatus.connected, igStatus.username, igStatus.followersCount]);

  // Auto-trigger once thumbnails are ready
  useEffect(() => {
    if (!thumbsReady || igLoading || analyzedRef.current || !user?.id) return;
    if (eventsRef.current.length > 0) {
      analyzedRef.current = true;
      runAnalysis(eventsRef.current, itemsRef.current.length, 0, 'replace');
    } else {
      setLoading(false);
    }
  }, [thumbsReady, igLoading, user?.id, runAnalysis]);

  const handleRetry = () => {
    analyzedRef.current = false;
    loadMoreOffsetRef.current = BATCH_SIZE;
    if (eventsRef.current.length > 0 && user?.id) {
      runAnalysis(eventsRef.current, itemsRef.current.length, 0, 'replace');
    } else {
      loadGallery();
    }
  };

  const handleRefresh = () => {
    if (loading || loadingMore) return;
    analyzedRef.current = false;
    loadMoreOffsetRef.current = BATCH_SIZE;
    if (eventsRef.current.length > 0 && user?.id) {
      runAnalysis(eventsRef.current, itemsRef.current.length, 0, 'replace');
    } else {
      loadGallery();
    }
  };

  const handleLoadMore = () => {
    if (loading || loadingMore || !user?.id || eventsRef.current.length === 0) return;
    const total = eventsRef.current.length;
    const offset = loadMoreOffsetRef.current;
    loadMoreOffsetRef.current = (offset + BATCH_SIZE) % total;
    runAnalysis(eventsRef.current, itemsRef.current.length, offset, 'append');
  };

  const handleMakeReel = (s: Suggestion, batchEvents: EventCluster[]) => {
    const picks: PendingReelItem[] = (s.galleryIndices ?? [])
      .map(i => {
        const ev = batchEvents[i];
        if (!ev) return null;
        return {
          uri: ev.rep.uri,
          type: ev.rep.type,
          previewUri: ev.base64 ? `data:image/jpeg;base64,${ev.base64}` : ev.rep.uri,
          durationSec: ev.rep.durationSec,
        };
      })
      .filter((x): x is PendingReelItem => x !== null);
    if (picks.length) setPendingReelItems(picks, true, { title: s.title, hook: s.hook });
    router.push('/upload');
  };

  const totalSuggestions = result?.batches.reduce((n, b) => n + b.suggestions.length, 0) ?? 0;

  // ── Permission denied ─────────────────────────────────────────────────────
  if (permission === 'denied') {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Reel Ideas</Text>
        </View>
        <View style={styles.centeredBox}>
          <MaterialIcons name="photo-library" size={48} color={Colors.textMuted} />
          <Text style={styles.centeredTitle}>Media Access Required</Text>
          <Text style={styles.centeredSub}>Allow photo library access to generate reel ideas from your memories.</Text>
          <Pressable style={styles.actionBtn} onPress={loadGallery}>
            <Text style={styles.actionBtnText}>Allow Access</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Reel Ideas</Text>
          <Text style={styles.headerSub} numberOfLines={1}>
            {loading
              ? loadingStep
              : result
                ? `${totalSuggestions} niche-matched ideas for you`
                : 'AI-powered suggestions from your gallery'}
          </Text>
        </View>
        <Pressable style={styles.refreshBtn} onPress={handleRefresh} disabled={loading || loadingMore}>
          <MaterialIcons name="refresh" size={20} color={(loading || loadingMore) ? Colors.textMuted : Colors.textSecondary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* Instagram connect banner */}
        {!igLoading && !igStatus.connected && (
          <Pressable style={styles.igBanner} onPress={() => router.push('/profile')}>
            <MaterialCommunityIcons name="instagram" size={18} color={Colors.rose} />
            <Text style={styles.igBannerText}>Connect Instagram for personalised suggestions</Text>
            <MaterialIcons name="chevron-right" size={16} color={Colors.rose} />
          </Pressable>
        )}

        {/* Connected badge */}
        {!igLoading && igStatus.connected && igStatus.username && (
          <View style={styles.igConnected}>
            <MaterialCommunityIcons name="instagram" size={14} color={Colors.emerald} />
            <Text style={styles.igConnectedText}>@{liveProfile?.username ?? igStatus.username}</Text>
            {(liveProfile?.followersCount ?? igStatus.followersCount) != null && (
              <Text style={styles.igFollowers}>
                · {(liveProfile?.followersCount ?? igStatus.followersCount)!.toLocaleString()} followers
              </Text>
            )}
          </View>
        )}

        {/* Full-screen loading */}
        {loading && (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color={Colors.primary} />
            <Text style={styles.loadingText}>{loadingStep}</Text>
          </View>
        )}

        {/* Error */}
        {!loading && !!error && (
          <View style={styles.errorBox}>
            <MaterialIcons name="error-outline" size={20} color={Colors.rose} />
            <Text style={styles.errorText}>{error}</Text>
            <Pressable style={styles.retryBtn} onPress={handleRetry}>
              <Text style={styles.retryBtnText}>Try Again</Text>
            </Pressable>
          </View>
        )}

        {/* Niche banner */}
        {!loading && !!result?.niche && (
          <View style={styles.nicheBanner}>
            <MaterialCommunityIcons name="target" size={14} color={Colors.amber} />
            <Text style={styles.nicheText} numberOfLines={2}>{result.niche}</Text>
          </View>
        )}

        {/* All batches */}
        {!loading && !!result && result.batches.map((batch, batchIdx) => {
          const globalOffset = batchIdx * BATCH_SIZE;
          return (
            <React.Fragment key={batchIdx}>
              {/* Batch header (only for load-more batches) */}
              {batchIdx > 0 && (
                <View style={styles.batchDivider}>
                  <View style={styles.batchDividerLine} />
                  <View style={styles.batchDividerChip}>
                    <MaterialCommunityIcons name="creation" size={12} color={Colors.violet} />
                    <Text style={styles.batchDividerText}>More Ideas</Text>
                  </View>
                  <View style={styles.batchDividerLine} />
                </View>
              )}

              {/* First batch section header */}
              {batchIdx === 0 && (
                <View style={styles.sectionHeader}>
                  <MaterialCommunityIcons name="creation" size={14} color={Colors.violet} />
                  <Text style={[styles.sectionTitle, { color: Colors.violet }]}>
                    {batch.suggestions.length} Reel Ideas For You
                  </Text>
                </View>
              )}

              {/* Suggestion cards */}
              {batch.suggestions.map((s, i) => {
                const globalIndex = globalOffset + i + 1;
                const color = TYPE_COLOR[s.contentType] ?? Colors.sky;
                const thumbEv = batch.analysisEvents[s.galleryIndices?.[0]];
                return (
                  <View key={`${batchIdx}-${s.id ?? i}`} style={styles.card}>
                    {thumbEv && (
                      <View style={styles.cardThumbWrap}>
                        <Image source={{ uri: thumbEv.rep.uri }} style={styles.cardThumb} contentFit="cover" />
                        <View style={styles.cardThumbGradient} />
                        <View style={styles.cardRankOverlay}>
                          <Text style={styles.cardRankText}>{globalIndex}</Text>
                        </View>
                        {thumbEv.rep.type === 'video' && (
                          <View style={styles.cardVideoTag}>
                            <MaterialIcons name="videocam" size={12} color="#fff" />
                          </View>
                        )}
                        <View style={[styles.cardTypeBadge, { backgroundColor: color + 'dd' }]}>
                          <Text style={styles.cardTypeBadgeText}>{TYPE_LABEL[s.contentType] ?? s.contentType}</Text>
                        </View>
                      </View>
                    )}
                    <View style={styles.cardBody}>
                      {!thumbEv && (
                        <View style={styles.cardHeaderNoThumb}>
                          <View style={styles.cardRank}><Text style={styles.cardRankText}>{globalIndex}</Text></View>
                          <View style={[styles.typeBadge, { borderColor: color + '55', backgroundColor: color + '22' }]}>
                            <Text style={[styles.typeBadgeText, { color }]}>{TYPE_LABEL[s.contentType] ?? s.contentType}</Text>
                          </View>
                        </View>
                      )}
                      <Text style={styles.cardTitle} numberOfLines={2}>{s.title}</Text>
                      <View style={styles.hookBox}>
                        <Text style={styles.hookLabel}>HOOK</Text>
                        <Text style={styles.hookText}>"{s.hook}"</Text>
                      </View>
                      <Text style={styles.reasonText}>{s.reason}</Text>
                      <Pressable
                        style={({ pressed }) => [styles.makeBtn, pressed && { opacity: 0.85 }]}
                        onPress={() => handleMakeReel(s, batch.analysisEvents)}
                      >
                        <MaterialIcons name="movie-creation" size={16} color="#fff" />
                        <Text style={styles.makeBtnText}>Make This Reel</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </React.Fragment>
          );
        })}

        {/* Load More */}
        {!loading && !!result && (
          <View style={styles.loadMoreSection}>
            {loadingMore ? (
              <View style={styles.loadMoreSpinner}>
                <ActivityIndicator size="small" color={Colors.primary} />
                <Text style={styles.loadMoreText}>Finding more ideas…</Text>
              </View>
            ) : (
              <Pressable
                style={({ pressed }) => [styles.loadMoreBtn, pressed && { opacity: 0.8 }]}
                onPress={handleLoadMore}
              >
                <MaterialCommunityIcons name="crown-outline" size={18} color={Colors.primary} />
                <Text style={styles.loadMoreBtnText}>Load More Ideas</Text>
                <Text style={styles.loadMoreHint}>from different moments</Text>
              </Pressable>
            )}
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.sm,
    borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder,
  },
  headerTitle: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Colors.textPrimary, includeFontPadding: false },
  headerSub: { fontSize: FontSize.xs, color: Colors.textSecondary, includeFontPadding: false, marginTop: 2 },
  refreshBtn: {
    width: 36, height: 36, borderRadius: Radius.full,
    backgroundColor: Colors.surfaceElevated, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  scrollContent: { padding: Spacing.md, gap: Spacing.md },
  loadingBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 16 },
  loadingText: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  sectionTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, includeFontPadding: false },
  batchDivider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 4 },
  batchDividerLine: { flex: 1, height: 1, backgroundColor: Colors.surfaceBorder },
  batchDividerChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: Colors.violet + '22', borderRadius: Radius.full,
    paddingHorizontal: 12, paddingVertical: 5,
    borderWidth: 1, borderColor: Colors.violet + '44',
  },
  batchDividerText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.violet, includeFontPadding: false },
  loadMoreSection: { alignItems: 'center', paddingVertical: Spacing.sm },
  loadMoreBtn: {
    alignItems: 'center', gap: 4,
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.xl,
    paddingVertical: 16, paddingHorizontal: 32,
    borderWidth: 1.5, borderColor: Colors.primary + '66',
    borderStyle: 'dashed',
    width: '100%',
  },
  loadMoreBtnText: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: Colors.primary, includeFontPadding: false },
  loadMoreHint: { fontSize: FontSize.xs, color: Colors.textMuted, includeFontPadding: false },
  loadMoreSpinner: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 16 },
  loadMoreText: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
  nicheBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: Colors.amber + '18', borderRadius: Radius.md,
    padding: Spacing.sm + 4, borderWidth: 1, borderColor: Colors.amber + '44',
  },
  nicheText: {
    flex: 1, fontSize: FontSize.sm, color: Colors.amber,
    fontWeight: FontWeight.semibold, includeFontPadding: false, lineHeight: 18,
  },
  igBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.rose + '18', borderRadius: Radius.md,
    padding: Spacing.sm + 4, borderWidth: 1, borderColor: Colors.rose + '44',
  },
  igBannerText: { flex: 1, fontSize: FontSize.sm, color: Colors.rose, fontWeight: FontWeight.semibold, includeFontPadding: false },
  igConnected: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.emerald + '15', borderRadius: Radius.md,
    padding: Spacing.sm + 2, borderWidth: 1, borderColor: Colors.emerald + '33',
  },
  igConnectedText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.emerald, includeFontPadding: false },
  igFollowers: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
  errorBox: {
    gap: 10, backgroundColor: Colors.rose + '18', borderRadius: Radius.md,
    padding: Spacing.md, borderWidth: 1, borderColor: Colors.rose + '44',
  },
  errorText: { fontSize: FontSize.sm, color: Colors.rose, includeFontPadding: false, lineHeight: 18 },
  retryBtn: {
    alignSelf: 'flex-start', backgroundColor: Colors.rose, borderRadius: Radius.full,
    paddingVertical: 8, paddingHorizontal: 18,
  },
  retryBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: FontWeight.bold, includeFontPadding: false },
  centeredBox: { alignItems: 'center', gap: Spacing.sm, paddingVertical: 60, paddingHorizontal: Spacing.xl },
  centeredTitle: {
    fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary,
    includeFontPadding: false, textAlign: 'center',
  },
  centeredSub: {
    fontSize: FontSize.sm, color: Colors.textSecondary,
    textAlign: 'center', includeFontPadding: false, lineHeight: 20,
  },
  actionBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.full,
    paddingVertical: 12, paddingHorizontal: 28, marginTop: Spacing.sm,
  },
  actionBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: FontWeight.bold, includeFontPadding: false },
  card: {
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.xl,
    borderWidth: 1.5, borderColor: Colors.primary + '55',
    overflow: 'hidden',
  },
  cardThumbWrap: { width: '100%', height: 180, position: 'relative' },
  cardThumb: { width: '100%', height: '100%' },
  cardThumbGradient: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.25)' },
  cardRankOverlay: {
    position: 'absolute', top: 10, left: 10,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  cardVideoTag: {
    position: 'absolute', top: 10, right: 10,
    backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 4, padding: 4,
  },
  cardTypeBadge: {
    position: 'absolute', bottom: 10, left: 10,
    borderRadius: Radius.sm, paddingHorizontal: 8, paddingVertical: 3,
  },
  cardTypeBadgeText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  cardBody: { padding: Spacing.md, gap: Spacing.sm },
  cardHeaderNoThumb: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  cardRank: {
    width: 26, height: 26, borderRadius: 13, flexShrink: 0,
    backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  cardRankText: { fontSize: FontSize.sm, fontWeight: FontWeight.extrabold, color: '#fff', includeFontPadding: false },
  cardTitle: {
    fontSize: FontSize.md, fontWeight: FontWeight.bold,
    color: Colors.textPrimary, includeFontPadding: false, lineHeight: 22,
  },
  typeBadge: { borderRadius: Radius.sm, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, flexShrink: 0 },
  typeBadgeText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, includeFontPadding: false },
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
  reasonText: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false, lineHeight: 19 },
  makeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, backgroundColor: Colors.primary, borderRadius: Radius.full,
    paddingVertical: 12,
  },
  makeBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
});
