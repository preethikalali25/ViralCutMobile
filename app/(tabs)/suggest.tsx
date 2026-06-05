import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, Pressable, FlatList,
  ActivityIndicator, Dimensions, ScrollView,
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
const GAP = 2;
const COLS = 3;
const CELL = (width - GAP * (COLS - 1)) / COLS;
const EVENT_GAP_MS = 3 * 60 * 60 * 1000; // 3 h gap = new event
const MAX_EVENTS = 8;

// ─── Types ────────────────────────────────────────────────────────────────────

type GalleryItem = {
  id: string;
  uri: string;
  type: 'photo' | 'video';
  durationSec?: number;
  creationTime: number; // ms
};

type EventCluster = {
  label: string;    // "Jun 3, 2025"
  count: number;    // photos/videos in this session
  rep: GalleryItem; // best representative (video preferred)
  base64?: string;  // thumbnail sent to AI
};

type Suggestion = {
  id: string;
  title: string;
  hook: string;
  reason: string;
  galleryIndices: number[]; // indices into events array
  contentType: 'photo_montage' | 'video_clip' | 'mixed';
};

type AnalysisResult = {
  profile: { username?: string; followers?: number; bio?: string };
  suggestions: Suggestion[];
};

const TYPE_LABEL: Record<string, string> = {
  photo_montage: 'Photo Montage',
  video_clip: 'Video Clip',
  mixed: 'Mixed',
};

// ─── Event clustering (like Apple/Google Memories) ───────────────────────────

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
    if (gap <= EVENT_GAP_MS) {
      batch.push(sorted[i]);
    } else {
      flush();
      batch = [sorted[i]];
    }
  }
  flush();
  return clusters;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function SuggestScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { status: igStatus } = useInstagram();

  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loadedCount, setLoadedCount] = useState(0);
  const [loadingGallery, setLoadingGallery] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');

  const [events, setEvents] = useState<EventCluster[]>([]);
  const [thumbsReady, setThumbsReady] = useState(false);
  const thumbsStarted = useRef(false);

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeStep, setAnalyzeStep] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Thumbnail generation ───────────────────────────────────────────────────

  const genThumb = async (ev: EventCluster): Promise<string | null> => {
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
  };

  const generateThumbs = useCallback(async (evList: EventCluster[]) => {
    const working = [...evList];
    for (let i = 0; i < Math.min(working.length, MAX_EVENTS); i++) {
      const b64 = await genThumb(working[i]);
      if (b64) {
        working[i] = { ...working[i], base64: b64 };
        setEvents([...working]);
      }
    }
    setThumbsReady(true);
  }, []);

  // ── Gallery loading ────────────────────────────────────────────────────────

  const loadGallery = useCallback(async () => {
    setLoadingGallery(true);
    setItems([]);
    setEvents([]);
    setThumbsReady(false);
    thumbsStarted.current = false;

    const { granted } = await MediaLibrary.requestPermissionsAsync();
    if (!granted) { setPermission('denied'); setLoadingGallery(false); return; }
    setPermission('granted');

    const toItem = (a: MediaLibrary.Asset): GalleryItem => ({
      id: a.id,
      uri: a.uri,
      type: a.mediaType === MediaLibrary.MediaType.video ? 'video' : 'photo',
      durationSec: a.duration ? Math.round(a.duration) : undefined,
      creationTime: a.creationTime,
    });

    const first = await MediaLibrary.getAssetsAsync({
      mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      first: 200,
    });

    let allLoaded = first.assets.map(toItem);
    setItems(allLoaded);
    setLoadedCount(allLoaded.length);
    setLoadingGallery(false);

    // Cluster first batch and start background thumb generation immediately
    const initialEvents = buildEvents(allLoaded);
    setEvents(initialEvents);
    if (!thumbsStarted.current) {
      thumbsStarted.current = true;
      generateThumbs(initialEvents);
    }

    // Load remaining pages in background while showing results
    if (first.hasNextPage) {
      setLoadingMore(true);
      let cursor: string | undefined = first.endCursor;
      while (cursor) {
        const page = await MediaLibrary.getAssetsAsync({
          mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
          sortBy: [[MediaLibrary.SortBy.creationTime, false]],
          first: 200,
          after: cursor,
        });
        allLoaded = [...allLoaded, ...page.assets.map(toItem)];
        setItems([...allLoaded]);
        setLoadedCount(allLoaded.length);
        cursor = page.hasNextPage ? page.endCursor : undefined;
      }
      setLoadingMore(false);

      // Re-cluster with complete data; preserve already-generated thumbs for top events
      const finalEvents = buildEvents(allLoaded);
      setEvents(prev => finalEvents.map((ev, i) => ({ ...ev, base64: prev[i]?.base64 })));
    }
  }, [generateThumbs]);

  useEffect(() => { loadGallery(); }, [loadGallery]);

  // ── Analyse ────────────────────────────────────────────────────────────────

  const handleAnalyze = async () => {
    if (!user?.id) return;
    if (!igStatus.connected) {
      setError('Connect your Instagram account first — go to the Profile tab and tap "Connect Instagram".');
      return;
    }
    if (events.length === 0) {
      setError('No events found in your gallery. Allow media library access and try again.');
      return;
    }

    setAnalyzing(true);
    setError(null);
    setResult(null);

    const topEvents = events.slice(0, MAX_EVENTS);
    setAnalyzeStep('Preparing events…');

    // Ensure thumbnails for all top events
    const thumbs: Array<{
      id: string; type: 'photo' | 'video'; base64: string;
      eventLabel: string; eventCount: number;
    }> = [];

    for (let i = 0; i < topEvents.length; i++) {
      const ev = topEvents[i];
      const b64 = ev.base64 ?? (await genThumb(ev));
      if (b64) thumbs.push({ id: ev.rep.id, type: ev.rep.type, base64: b64, eventLabel: ev.label, eventCount: ev.count });
    }

    setAnalyzeStep('Analysing your Instagram profile…');
    const supabase = getSupabaseClient();
    const { data, error: fnErr } = await supabase.functions.invoke('content-advisor', {
      body: {
        userId: user.id,
        galleryThumbnails: thumbs,
        totalItems: items.length,
        totalEvents: events.length,
      },
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

  const handleMakeReel = (s: Suggestion) => {
    const picks: PendingReelItem[] = (s.galleryIndices ?? [])
      .map(i => events[i]?.rep)
      .filter(Boolean)
      .map(g => ({ uri: g.uri, type: g.type, previewUri: g.uri, durationSec: g.durationSec }));
    if (picks.length) setPendingReelItems(picks);
    router.push('/upload');
  };

  // ── Header (above grid) ───────────────────────────────────────────────────

  const ListHeader = () => (
    <View>
      {/* Instagram status */}
      {!igStatus.connected ? (
        <Pressable style={styles.igBanner} onPress={() => router.push('/profile')}>
          <MaterialCommunityIcons name="instagram" size={18} color={Colors.rose} />
          <Text style={styles.igBannerText}>Connect Instagram for personalised suggestions</Text>
          <MaterialIcons name="chevron-right" size={16} color={Colors.rose} />
        </Pressable>
      ) : igStatus.username ? (
        <View style={styles.igConnected}>
          <MaterialCommunityIcons name="instagram" size={16} color={Colors.emerald} />
          <Text style={styles.igConnectedText}>@{igStatus.username}</Text>
          {igStatus.followersCount != null && (
            <Text style={styles.igFollowers}>· {igStatus.followersCount.toLocaleString()} followers</Text>
          )}
        </View>
      ) : null}

      {/* Events strip */}
      {events.length > 0 && (
        <View style={styles.eventsSection}>
          <View style={styles.eventsHeaderRow}>
            <MaterialCommunityIcons name="calendar-month-outline" size={13} color={Colors.textSecondary} />
            <Text style={styles.eventsHeaderText}>
              {events.length} events detected · {thumbsReady ? 'Ready' : 'Preparing…'}
            </Text>
            {!thumbsReady && <ActivityIndicator size="small" color={Colors.primaryLight} style={{ marginLeft: 4 }} />}
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.eventsRow}>
            {events.slice(0, MAX_EVENTS).map((ev, i) => (
              <View key={i} style={styles.eventCard}>
                <View style={styles.eventThumbBox}>
                  <Image source={{ uri: ev.rep.uri }} style={styles.eventThumb} contentFit="cover" />
                  {!ev.base64 && (
                    <View style={styles.eventThumbOverlay}>
                      <ActivityIndicator size="small" color="#fff" />
                    </View>
                  )}
                  <View style={styles.eventIdxBadge}>
                    <Text style={styles.eventIdxText}>{i}</Text>
                  </View>
                  {ev.rep.type === 'video' && (
                    <View style={styles.eventVideoTag}>
                      <MaterialIcons name="videocam" size={8} color="#fff" />
                    </View>
                  )}
                </View>
                <Text style={styles.eventLabel} numberOfLines={1}>{ev.label}</Text>
                <Text style={styles.eventCount}>{ev.count} items</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Analyse button */}
      {permission === 'granted' && !loadingGallery && (
        <Pressable
          style={({ pressed }) => [
            styles.analyzeBtn,
            (analyzing || events.length === 0) && styles.analyzeBtnDisabled,
            pressed && { opacity: 0.85 },
          ]}
          onPress={handleAnalyze}
          disabled={analyzing || events.length === 0}
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
      {!!error && (
        <View style={styles.errorBox}>
          <MaterialIcons name="error-outline" size={16} color={Colors.rose} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Suggestion cards */}
      {!!result && (
        <View style={styles.suggestionsSection}>
          <View style={styles.suggestionsHeader}>
            <MaterialCommunityIcons name="creation" size={16} color={Colors.violet} />
            <Text style={styles.suggestionsTitle}>3 Reel Ideas for You</Text>
          </View>
          {result.suggestions.map((s, i) => (
            <View key={s.id ?? i} style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.cardRank}><Text style={styles.cardRankText}>{i + 1}</Text></View>
                <Text style={styles.cardTitle} numberOfLines={2}>{s.title}</Text>
                <View style={[
                  styles.typeBadge,
                  s.contentType === 'video_clip' && styles.typeBadgeVideo,
                  s.contentType === 'mixed' && styles.typeBadgeMixed,
                ]}>
                  <Text style={styles.typeBadgeText}>{TYPE_LABEL[s.contentType] ?? s.contentType}</Text>
                </View>
              </View>
              <View style={styles.hookBox}>
                <Text style={styles.hookLabel}>HOOK</Text>
                <Text style={styles.hookText}>"{s.hook}"</Text>
              </View>
              <Text style={styles.reasonText}>{s.reason}</Text>
              {s.galleryIndices?.length > 0 && (
                <View style={styles.clipsRow}>
                  <Text style={styles.clipsLabel}>From these events:</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.clipsScroll}>
                    {s.galleryIndices.map(idx => {
                      const ev = events[idx];
                      if (!ev) return null;
                      return (
                        <View key={idx} style={styles.clipThumbWrap}>
                          <Image source={{ uri: ev.rep.uri }} style={styles.clipThumb} contentFit="cover" />
                          <View style={styles.clipIdx}><Text style={styles.clipIdxText}>{idx}</Text></View>
                        </View>
                      );
                    })}
                  </ScrollView>
                </View>
              )}
              <Pressable style={({ pressed }) => [styles.makeBtn, pressed && { opacity: 0.85 }]} onPress={() => handleMakeReel(s)}>
                <MaterialIcons name="movie-creation" size={16} color="#fff" />
                <Text style={styles.makeBtnText}>Make This Reel</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <Text style={styles.sectionLabel}>
        {loadingMore ? `Scanning… ${loadedCount} items` : `All Media · ${loadedCount} items`}
      </Text>
    </View>
  );

  // ── Permission denied ─────────────────────────────────────────────────────

  if (permission === 'denied') {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Reel Ideas</Text>
        </View>
        <View style={styles.permissionBox}>
          <MaterialIcons name="photo-library" size={40} color={Colors.textMuted} />
          <Text style={styles.permissionTitle}>Media Access Required</Text>
          <Text style={styles.permissionSub}>Allow photo library access to detect events and suggest reels.</Text>
          <Pressable style={styles.permissionBtn} onPress={loadGallery}>
            <Text style={styles.permissionBtnText}>Allow Access</Text>
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
            {loadingMore
              ? `Scanning gallery… ${loadedCount} items`
              : loadedCount > 0
                ? `${loadedCount} items · ${events.length} event${events.length !== 1 ? 's' : ''} detected`
                : 'AI-powered suggestions from your gallery'}
          </Text>
        </View>
        <Pressable style={styles.refreshBtn} onPress={loadGallery}>
          <MaterialIcons name="refresh" size={20} color={Colors.textSecondary} />
        </Pressable>
      </View>

      {loadingGallery ? (
        <View style={styles.galleryLoading}>
          <ActivityIndicator color={Colors.primary} />
          <Text style={styles.galleryLoadingText}>Loading gallery…</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          numColumns={COLS}
          keyExtractor={item => item.id}
          showsVerticalScrollIndicator={false}
          columnWrapperStyle={{ gap: GAP }}
          ItemSeparatorComponent={() => <View style={{ height: GAP }} />}
          ListHeaderComponent={<ListHeader />}
          renderItem={({ item }) => (
            <View style={styles.gridCell}>
              <Image source={{ uri: item.uri }} style={styles.gridThumb} contentFit="cover" />
              {item.type === 'video' && (
                <View style={styles.videoTag}>
                  <MaterialIcons name="videocam" size={9} color="#fff" />
                  {item.durationSec != null && (
                    <Text style={styles.videoTagText}>{Math.min(item.durationSec, 60)}s</Text>
                  )}
                </View>
              )}
            </View>
          )}
          ListFooterComponent={
            loadingMore
              ? <View style={styles.loadMoreRow}>
                  <ActivityIndicator color={Colors.primary} size="small" />
                  <Text style={styles.loadMoreText}>Loading more…</Text>
                </View>
              : <View style={{ height: Spacing.xl }} />
          }
        />
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
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
  galleryLoading: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12,
  },
  galleryLoadingText: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
  igBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    margin: Spacing.md, backgroundColor: Colors.rose + '18',
    borderRadius: Radius.md, padding: Spacing.sm + 4,
    borderWidth: 1, borderColor: Colors.rose + '44',
  },
  igBannerText: { flex: 1, fontSize: FontSize.sm, color: Colors.rose, fontWeight: FontWeight.semibold, includeFontPadding: false },
  igConnected: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginHorizontal: Spacing.md, marginTop: Spacing.sm, marginBottom: 4,
    backgroundColor: Colors.emerald + '15', borderRadius: Radius.md, padding: Spacing.sm + 2,
    borderWidth: 1, borderColor: Colors.emerald + '33',
  },
  igConnectedText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.emerald, includeFontPadding: false },
  igFollowers: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
  // Events
  eventsSection: { marginTop: Spacing.md },
  eventsHeaderRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.md, marginBottom: Spacing.sm,
  },
  eventsHeaderText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: FontWeight.semibold, includeFontPadding: false },
  eventsRow: { paddingHorizontal: Spacing.md, gap: 10 },
  eventCard: { width: 72, alignItems: 'center', gap: 3 },
  eventThumbBox: {
    width: 72, height: 90, borderRadius: Radius.md, overflow: 'hidden',
    backgroundColor: Colors.surfaceElevated, position: 'relative',
  },
  eventThumb: { width: '100%', height: '100%' },
  eventThumbOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center',
  },
  eventIdxBadge: {
    position: 'absolute', top: 3, right: 3,
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  eventIdxText: { fontSize: 8, color: '#fff', fontWeight: FontWeight.extrabold, includeFontPadding: false },
  eventVideoTag: {
    position: 'absolute', bottom: 3, left: 3,
    backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 3, padding: 2,
  },
  eventLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, includeFontPadding: false, textAlign: 'center' },
  eventCount: { fontSize: 9, color: Colors.textMuted, includeFontPadding: false },
  // Analyse
  analyzeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: Colors.primary,
    marginHorizontal: Spacing.md, marginTop: Spacing.md, marginBottom: Spacing.sm,
    borderRadius: Radius.full, paddingVertical: 15,
  },
  analyzeBtnDisabled: { opacity: 0.45 },
  analyzingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  analyzeBtnText: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  // Error
  errorBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    marginHorizontal: Spacing.md, marginBottom: Spacing.sm,
    backgroundColor: Colors.rose + '18', borderRadius: Radius.md,
    padding: Spacing.sm + 4, borderWidth: 1, borderColor: Colors.rose + '44',
  },
  errorText: { flex: 1, fontSize: FontSize.sm, color: Colors.rose, includeFontPadding: false, lineHeight: 18 },
  // Suggestions
  suggestionsSection: { marginBottom: Spacing.sm },
  suggestionsHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.md, marginBottom: Spacing.sm,
  },
  suggestionsTitle: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: Colors.violet, includeFontPadding: false },
  card: {
    marginHorizontal: Spacing.md, marginBottom: Spacing.md,
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.xl,
    borderWidth: 1.5, borderColor: Colors.primary + '55',
    padding: Spacing.md, gap: Spacing.sm,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  cardRank: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  cardRankText: { fontSize: FontSize.sm, fontWeight: FontWeight.extrabold, color: '#fff', includeFontPadding: false },
  cardTitle: { flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.bold, color: Colors.textPrimary, includeFontPadding: false, lineHeight: 22 },
  typeBadge: {
    backgroundColor: Colors.sky + '22', borderRadius: Radius.sm,
    paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: Colors.sky + '55', flexShrink: 0,
  },
  typeBadgeVideo: { backgroundColor: Colors.violet + '22', borderColor: Colors.violet + '55' },
  typeBadgeMixed: { backgroundColor: Colors.amber + '22', borderColor: Colors.amber + '55' },
  typeBadgeText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.sky, includeFontPadding: false },
  hookBox: {
    backgroundColor: Colors.primaryGlow, borderRadius: Radius.md,
    padding: Spacing.sm + 4, borderWidth: 1, borderColor: Colors.primary + '44',
  },
  hookLabel: { fontSize: 9, fontWeight: FontWeight.extrabold, color: Colors.primaryLight + 'aa', letterSpacing: 1, includeFontPadding: false, marginBottom: 4 },
  hookText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textPrimary, includeFontPadding: false, lineHeight: 20 },
  reasonText: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false, lineHeight: 19 },
  clipsRow: { gap: 4 },
  clipsLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, color: Colors.textMuted, includeFontPadding: false },
  clipsScroll: { marginTop: 2 },
  clipThumbWrap: {
    width: 52, height: 68, borderRadius: Radius.sm,
    overflow: 'hidden', marginRight: 6, position: 'relative', backgroundColor: Colors.surface,
  },
  clipThumb: { width: '100%', height: '100%' },
  clipIdx: {
    position: 'absolute', top: 2, right: 2, width: 14, height: 14, borderRadius: 7,
    backgroundColor: 'rgba(0,0,0,0.75)', alignItems: 'center', justifyContent: 'center',
  },
  clipIdxText: { fontSize: 8, color: '#fff', fontWeight: FontWeight.bold, includeFontPadding: false },
  makeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, backgroundColor: Colors.primary,
    borderRadius: Radius.full, paddingVertical: 12, marginTop: 4,
  },
  makeBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  // Gallery
  sectionLabel: {
    fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.textMuted,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.sm,
    includeFontPadding: false, textTransform: 'uppercase', letterSpacing: 0.6,
  },
  gridCell: { width: CELL, height: CELL * 1.2, backgroundColor: Colors.surfaceElevated, position: 'relative' },
  gridThumb: { width: '100%', height: '100%' },
  videoTag: {
    position: 'absolute', bottom: 3, left: 3,
    flexDirection: 'row', alignItems: 'center', gap: 2,
    backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3,
  },
  videoTagText: { fontSize: 8, color: '#fff', fontWeight: FontWeight.bold, includeFontPadding: false },
  loadMoreRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    justifyContent: 'center', padding: Spacing.md,
  },
  loadMoreText: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
  // Permission
  permissionBox: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.xl,
  },
  permissionTitle: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: Colors.textPrimary, includeFontPadding: false },
  permissionSub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', includeFontPadding: false },
  permissionBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.full,
    paddingVertical: 10, paddingHorizontal: 28, marginTop: Spacing.sm,
  },
  permissionBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: FontWeight.bold, includeFontPadding: false },
});
