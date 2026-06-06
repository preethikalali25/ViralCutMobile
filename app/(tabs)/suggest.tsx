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
import { FunctionsHttpError } from '@supabase/supabase-js';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useAuth } from '@/template';
import { Image } from 'expo-image';
import { useInstagram } from '@/hooks/useInstagram';
import { getInstagramProfile, InstagramProfile } from '@/services/instagramService';
import { setPendingReelItems, PendingReelItem } from '@/stores/pendingReel';

const { width } = Dimensions.get('window');
const CARD_GAP = 10;
const CARD_W = (width - Spacing.md * 2 - CARD_GAP) / 2;
const CARD_H = CARD_W * 1.25;

const EVENT_GAP_MS = 3 * 60 * 60 * 1000;
const MAX_EVENTS = 20;

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

type AnalysisResult = {
  niche: string;
  profile: { username?: string; followers?: number; bio?: string };
  suggestions: Suggestion[];
  analysisEvents: EventCluster[];
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

  // Gallery data — used for AI analysis only, not displayed
  const [events, setEvents] = useState<EventCluster[]>([]);
  const [itemCount, setItemCount] = useState(0);
  const [thumbsReady, setThumbsReady] = useState(false);
  const itemsRef = useRef<GalleryItem[]>([]);
  const eventsRef = useRef<EventCluster[]>([]);
  const thumbsStarted = useRef(false);
  const analyzedRef = useRef(false);
  const eventOffsetRef = useRef(0);
  const igProfileRef = useRef<InstagramProfile | null>(null);

  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [loading, setLoading] = useState(true);
  const [loadingStep, setLoadingStep] = useState('Scanning your gallery…');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Live profile data for display (ref alone won't re-render)
  const [liveProfile, setLiveProfile] = useState<InstagramProfile | null>(null);

  // Keep eventsRef in sync
  useEffect(() => { eventsRef.current = events; }, [events]);

  // ── Thumbnail generation ───────────────────────────────────────────────────
  const generateThumbs = useCallback(async (evList: EventCluster[]) => {
    const working = [...evList];
    for (let i = 0; i < Math.min(working.length, MAX_EVENTS); i++) {
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
    eventOffsetRef.current = 0;
    igProfileRef.current = null;
    setLiveProfile(null);
    itemsRef.current = [];
    eventsRef.current = [];
    setItemCount(0);

    const { granted } = await MediaLibrary.requestPermissionsAsync();
    if (!granted) { setPermission('denied'); setLoading(false); return; }
    setPermission('granted');

    const toItem = (a: MediaLibrary.Asset): GalleryItem => ({
      id: a.id, uri: a.uri,
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
        allLoaded = [...allLoaded, ...page.assets.map(toItem)];
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

  // ── Analysis (calls Anthropic directly) ───────────────────────────────────
  const runAnalysis = useCallback(async (evList: EventCluster[], totalItems: number, offset: number = 0) => {
    if (!user?.id) return;

    const apiKey = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;
    if (!apiKey) {
      setError('Anthropic API key not configured. Add EXPO_PUBLIC_ANTHROPIC_API_KEY to your .env file.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    // Fetch full Instagram profile (bio + recent posts) once per session
    if (igStatus.connected && user.id && !igProfileRef.current) {
      setLoadingStep('Loading your Instagram profile…');
      const fetched = await getInstagramProfile(user.id);
      igProfileRef.current = fetched;
      if (fetched) {
        setLiveProfile(fetched);
      } else {
        console.warn('[suggest] getInstagramProfile returned null — profile fetch failed or edge function not deployed');
      }
    }

    setLoadingStep('Analysing your niche… (~20 sec)');

    // Slice from offset, wrap around if near the end
    const total = evList.length;
    let topEvents: EventCluster[];
    if (total <= MAX_EVENTS) {
      topEvents = evList;
    } else {
      const start = offset % total;
      const end = start + MAX_EVENTS;
      topEvents = end <= total
        ? evList.slice(start, end)
        : [...evList.slice(start), ...evList.slice(0, end - total)];
    }

    const userContent: any[] = [];

    // Cap at 8 images — sending 20 over mobile is too slow even for Sonnet
    const MAX_IMAGES = 8;
    for (let i = 0; i < Math.min(topEvents.length, MAX_IMAGES); i++) {
      const ev = topEvents[i];
      const b64 = ev.base64 ?? (await genThumb(ev));
      if (b64) {
        userContent.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
        });
      }
    }

    // Build rich profile section
    let profileSection: string;
    const igProfile = igProfileRef.current;
    if (igProfile) {
      const postLines = (igProfile.recentPosts ?? [])
        .map((p, i) =>
          `  ${i + 1}. [${p.type}] ${p.date} | ${p.likes ?? '?'} likes | ${p.comments ?? '?'} comments | "${p.caption ?? 'no caption'}"`,
        )
        .join('\n');

      profileSection = `Instagram Profile:
Username: @${igProfile.username ?? igStatus.username ?? 'unknown'}
Bio: ${igProfile.bio || 'Not set'}
Followers: ${igProfile.followersCount?.toLocaleString() ?? igStatus.followersCount?.toLocaleString() ?? 'unknown'}
Total posts: ${igProfile.mediaCount ?? 'unknown'}

Last ${igProfile.recentPosts?.length ?? 0} posts (engagement data):
${postLines || '  (no posts found)'}`;
    } else if (igStatus.connected && igStatus.username) {
      profileSection = `Instagram Profile:\nUsername: @${igStatus.username}\nFollowers: ${igStatus.followersCount?.toLocaleString() ?? 'unknown'}\n(full profile unavailable)`;
    } else {
      profileSection = 'No Instagram profile connected — infer niche from gallery content only.';
    }

    const eventLines = topEvents
      .map((ev, i) => `  Event ${i}: ${ev.label} (${ev.count} items)`)
      .join('\n');

    userContent.push({
      type: 'text',
      text: `${profileSection}

Camera roll: ${totalItems} total items across ${evList.length} detected events.
The 8 thumbnails above (indices 0–7) are the specific occasions available as raw material:
${eventLines}

Identify the single dominant niche from all of this. Then give 8 niche-focused Reel ideas using these events as raw material. Return JSON only.`,
    });

    const systemPrompt = `You are an expert Instagram Reels strategist who creates scroll-stopping, niche-specific content.

═══ STEP 1: IDENTIFY THE NICHE ═══
Use this priority order:
1. If bio text is set → treat it as the primary niche signal
2. If recent posts exist → look at captions + what got highest likes/comments
3. If Instagram data is thin or missing → look at ALL 8 gallery thumbnails together and find the ONE consistent subject or theme (e.g. a baby appearing in most shots = "mom content", outdoor/nature shots = "adventure/hiking", food shots = "food content")

Write ONE specific niche sentence — be precise, not vague:
  ✗ "lifestyle" ✗ "family" ✗ "travel"
  ✓ "first-time mom documenting newborn and toddler moments" ✓ "solo female traveller exploring South Asia on a budget" ✓ "home cook sharing quick 30-minute dinner ideas"

═══ STEP 2: GENERATE 8 REEL IDEAS ═══
Use the gallery events as raw material, but FILTER every idea through the niche lens.

The transformation rule — do NOT just describe the thumbnail:
  ✗ WRONG: event is beach trip → title "Fun beach day" hook "We had so much fun!"
  ✓ RIGHT: event is beach trip, niche is mom content → title "Beach day survival guide with a toddler" hook "POV: packing for the beach with a toddler (15 bags later) 😅"

  ✗ WRONG: event is dinner out → title "Date night" hook "Beautiful evening"
  ✓ RIGHT: event is dinner out, niche is budget travel → title "Eating out in [city] for under $10" hook "Nobody tells you how cheap eating out here actually is"

For each of the 8 suggestions:
• TITLE (5–8 words): niche-branded, not a literal thumbnail description
• HOOK (under 80 chars): use a DIFFERENT format for each one:
    "POV: [relatable niche situation]"
    "Nobody tells you that [niche truth]..."
    "Things I wish I knew before [niche activity]"
    "[Number] signs you're a [niche identity]"
    "Real talk: [honest niche experience]"
    "Day [X] of [niche challenge/journey]"
    "I finally [niche milestone/thing]"
    "How I [niche achievement] with [constraint]"
• REASON: one sentence — name the niche and explain exactly why this will resonate
• galleryIndices: 0-based, max index 7
• contentType: vary across photo_montage, video_clip, mixed

Return ONLY a valid JSON object — no markdown, no code blocks:
{
  "niche": "One specific sentence describing the creator's exact niche and target audience",
  "suggestions": [
    {
      "id": "s1",
      "title": "Niche-specific reel title",
      "hook": "Scroll-stopping hook under 80 chars",
      "reason": "Why this resonates with [niche] audience",
      "galleryIndices": [0],
      "contentType": "photo_montage|video_clip|mixed"
    }
  ]
}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
          temperature: 0.7,
        }),
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errText = await res.text();
        setError(`AI error: ${errText}`);
        setLoading(false);
        return;
      }

      const aiData = await res.json();
      const rawText = ((aiData.content?.[0]?.text as string) ?? '').trim();

      let parsed: { niche?: string; suggestions?: Suggestion[] };
      try {
        const cleaned = rawText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        setError('AI returned invalid format. Please try again.');
        setLoading(false);
        return;
      }

      const suggestions = parsed.suggestions ?? (Array.isArray(parsed) ? parsed as unknown as Suggestion[] : []);

      setResult({
        niche: parsed.niche ?? '',
        profile: { username: igStatus.username, followers: igStatus.followersCount },
        suggestions,
        analysisEvents: topEvents,
      });
    } catch (err) {
      setError(`Error: ${String(err)}`);
    }

    setLoading(false);
  }, [user?.id, igStatus.connected, igStatus.username, igStatus.followersCount]);

  // Auto-trigger once gallery thumbnails are ready (no Instagram required)
  useEffect(() => {
    if (!thumbsReady || igLoading || analyzedRef.current || !user?.id) return;
    if (eventsRef.current.length > 0) {
      analyzedRef.current = true;
      runAnalysis(eventsRef.current, itemsRef.current.length, 0);
    } else {
      setLoading(false);
    }
  }, [thumbsReady, igLoading, user?.id, runAnalysis]);

  const handleRetry = () => {
    analyzedRef.current = false;
    if (eventsRef.current.length > 0 && user?.id) {
      runAnalysis(eventsRef.current, itemsRef.current.length, eventOffsetRef.current);
    } else {
      loadGallery();
    }
  };

  const handleRefresh = () => {
    analyzedRef.current = false;
    const total = eventsRef.current.length;
    if (total > MAX_EVENTS) {
      eventOffsetRef.current = (eventOffsetRef.current + MAX_EVENTS) % total;
    }
    if (eventsRef.current.length > 0 && user?.id) {
      runAnalysis(eventsRef.current, itemsRef.current.length, eventOffsetRef.current);
    } else {
      loadGallery();
    }
  };

  const handleMakeReel = (s: Suggestion) => {
    const analysisEvents = result?.analysisEvents ?? [];
    const picks: PendingReelItem[] = (s.galleryIndices ?? [])
      .map(i => analysisEvents[i]?.rep)
      .filter(Boolean)
      .map(g => ({ uri: g.uri, type: g.type, previewUri: g.uri, durationSec: g.durationSec }));
    if (picks.length) setPendingReelItems(picks);
    router.push('/upload');
  };

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
                ? `${result.suggestions.length} niche-matched ideas for you`
                : 'AI-powered suggestions from your gallery'}
          </Text>
        </View>
        <Pressable style={styles.refreshBtn} onPress={handleRefresh} disabled={loading}>
          <MaterialIcons name="refresh" size={20} color={loading ? Colors.textMuted : Colors.textSecondary} />
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

        {/* Connected badge — shows live data once profile is fetched */}
        {!igLoading && igStatus.connected && igStatus.username && (
          <View style={styles.igConnected}>
            <MaterialCommunityIcons name="instagram" size={14} color={Colors.emerald} />
            <Text style={styles.igConnectedText}>@{liveProfile?.username ?? igStatus.username}</Text>
            {(liveProfile?.followersCount ?? igStatus.followersCount) != null && (
              <Text style={styles.igFollowers}>
                · {(liveProfile?.followersCount ?? igStatus.followersCount)!.toLocaleString()} followers
                {liveProfile?.mediaCount != null ? ` · ${liveProfile.mediaCount} posts` : ''}
              </Text>
            )}
          </View>
        )}

        {/* Loading spinner */}
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

        {/* Identified niche banner */}
        {!loading && !!result?.niche && (
          <View style={styles.nicheBanner}>
            <MaterialCommunityIcons name="target" size={14} color={Colors.amber} />
            <Text style={styles.nicheText} numberOfLines={2}>{result.niche}</Text>
          </View>
        )}

        {/* Suggestions header */}
        {!loading && !!result && (
          <View style={styles.sectionHeader}>
            <MaterialCommunityIcons name="creation" size={14} color={Colors.violet} />
            <Text style={[styles.sectionTitle, { color: Colors.violet }]}>
              {result.suggestions.length} Reel Ideas For You
            </Text>
          </View>
        )}

        {/* Suggestion cards */}
        {!loading && !!result && result.suggestions.map((s, i) => {
          const color = TYPE_COLOR[s.contentType] ?? Colors.sky;
          const thumbEv = result.analysisEvents[s.galleryIndices?.[0]];
          return (
            <View key={s.id ?? i} style={styles.card}>
              {/* Thumbnail */}
              {thumbEv && (
                <View style={styles.cardThumbWrap}>
                  <Image source={{ uri: thumbEv.rep.uri }} style={styles.cardThumb} contentFit="cover" />
                  <View style={styles.cardThumbGradient} />
                  <View style={styles.cardRankOverlay}>
                    <Text style={styles.cardRankText}>{i + 1}</Text>
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
              {/* Content */}
              <View style={styles.cardBody}>
                {!thumbEv && (
                  <View style={styles.cardHeaderNoThumb}>
                    <View style={styles.cardRank}><Text style={styles.cardRankText}>{i + 1}</Text></View>
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
                  onPress={() => handleMakeReel(s)}
                >
                  <MaterialIcons name="movie-creation" size={16} color="#fff" />
                  <Text style={styles.makeBtnText}>Make This Reel</Text>
                </Pressable>
              </View>
            </View>
          );
        })}

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
  sectionTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textSecondary, includeFontPadding: false },
  // keep eventCard etc. as dead styles — removed from render but keep to avoid TS error
  eventCard: {
    width: CARD_W, height: CARD_H, borderRadius: Radius.md,
    overflow: 'hidden', backgroundColor: Colors.surfaceElevated,
  },
  eventThumb: { width: '100%', height: '100%' },
  thumbSpinner: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center',
  },
  videoTag: {
    position: 'absolute', top: 6, right: 6,
    backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 4, padding: 3,
  },
  eventOverlay: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 8, paddingVertical: 6,
  },
  eventDate: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  eventItems: { fontSize: 10, color: 'rgba(255,255,255,0.7)', includeFontPadding: false, marginTop: 1 },
  analyzingRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md,
    padding: Spacing.sm + 4, borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  analyzingText: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
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
  centeredBox: {
    alignItems: 'center', gap: Spacing.sm, paddingVertical: 60, paddingHorizontal: Spacing.xl,
  },
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
  cardThumbGradient: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
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
  typeBadge: {
    borderRadius: Radius.sm, paddingHorizontal: 7, paddingVertical: 3,
    borderWidth: 1, flexShrink: 0,
  },
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
