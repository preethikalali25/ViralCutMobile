import React from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useAuth } from '@/template';
import { useVideos } from '@/hooks/useVideos';
import { useAnalytics } from '@/hooks/useAnalytics';
import { useScheduledPosts } from '@/hooks/useScheduledPosts';
import { formatNumber, getRelativeTime } from '@/services/formatters';
import PlatformBadge from '@/components/ui/PlatformBadge';
import StatsCard from '@/components/ui/StatsCard';

const { width } = Dimensions.get('window');

function getInitials(email: string): string {
  const parts = email.split('@')[0].split(/[._-]/);
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || email[0]?.toUpperCase() || 'U';
}

export default function DashboardScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { videos } = useVideos();
  const { posts: scheduledPosts } = useScheduledPosts();
  const initials = user?.email ? getInitials(user.email) : 'U';

  const { data: analytics } = useAnalytics();

  const published = videos.filter(v => v.status === 'published');
  const ready = videos.filter(v => v.status === 'ready');
  const processing = videos.filter(v => v.status === 'processing' || v.status === 'uploading');
  const scheduled = scheduledPosts;

  const hasRealAnalytics = !!analytics && analytics.platforms.some(p => p.connected && p.posts > 0);
  const totalViews = hasRealAnalytics ? analytics!.totalViews : 0;
  const totalLikes = hasRealAnalytics ? analytics!.totalLikes : 0;

  const publishedWithMetrics = published.filter(v => v.metrics);
  const avgRetention = publishedWithMetrics.length > 0
    ? Math.round(publishedWithMetrics.reduce((s, v) => s + (v.metrics?.retention ?? 0), 0) / publishedWithMetrics.length)
    : 0;

  const recentPublished = hasRealAnalytics
    ? analytics!.topVideos.slice(0, 3)
    : [...publishedWithMetrics]
        .sort((a, b) => new Date(b.publishedAt!).getTime() - new Date(a.publishedAt!).getTime())
        .slice(0, 3);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable
            style={({ pressed }) => [styles.avatarBtn, pressed && { opacity: 0.8 }]}
            onPress={() => router.push('/profile')}
          >
            <View style={styles.avatarCircle}>
              <Text style={styles.avatarInitials}>{initials}</Text>
            </View>
            <View>
              <Text style={styles.greeting}>Welcome back</Text>
              <Text style={styles.subGreeting}>
                {processing.length > 0 ? `${processing.length} processing · ` : ''}
                {ready.length} ready · {scheduledPosts.length} scheduled
              </Text>
            </View>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.newBtn, pressed && { opacity: 0.8 }]}
            onPress={() => router.push('/upload')}
          >
            <MaterialIcons name="add" size={18} color="#fff" />
            <Text style={styles.newBtnText}>New</Text>
          </Pressable>
        </View>

        {/* Hero Banner */}
        <View style={styles.heroBanner}>
          <Image
            source={require('@/assets/images/hero-banner.png')}
            style={styles.heroImage}
            contentFit="cover"
            transition={300}
          />
          <View style={styles.heroOverlay}>
            <MaterialCommunityIcons name="scissors-cutting" size={28} color={Colors.primaryLight} />
            <Text style={styles.heroTitle}>SmartReel</Text>

            <Text style={styles.heroSub}>AI-powered short-form video studio</Text>
          </View>
        </View>

        {/* Stats */}
        <Text style={styles.sectionTitle}>Overview</Text>
        <View style={styles.statsGrid}>
          <View style={styles.statsRow}>
            <View style={{ flex: 1 }}>
              <StatsCard label="Videos" value={String(published.length + ready.length)} change={`${scheduledPosts.length} scheduled`} changeType="neutral" accentColor={Colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <StatsCard label="Total Views" value={formatNumber(totalViews)} change={hasRealAnalytics ? 'Live data' : 'Connect platforms'} changeType={hasRealAnalytics ? 'up' : 'neutral'} accentColor={Colors.sky} />
            </View>
          </View>
          <View style={styles.statsRow}>
            <View style={{ flex: 1 }}>
              <StatsCard label="Total Likes" value={formatNumber(totalLikes)} change={hasRealAnalytics ? 'Across platforms' : 'Connect platforms'} changeType={hasRealAnalytics ? 'up' : 'neutral'} accentColor={Colors.pink} />
            </View>
            <View style={{ flex: 1 }}>
              <StatsCard label="Avg. Retention" value={avgRetention > 0 ? `${avgRetention}%` : '--'} change={avgRetention > 0 ? 'From local data' : 'No data yet'} changeType={avgRetention > 0 ? 'up' : 'neutral'} accentColor={Colors.emerald} />
            </View>
          </View>
        </View>

        {/* Upcoming */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Upcoming Posts</Text>
          <Pressable onPress={() => router.push('/(tabs)/schedule')}>
            <Text style={styles.seeAll}>See all</Text>
          </Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.horizontalScroll}>
          {scheduled.length > 0 ? scheduled.map(p => {
            const platformColor = p.platform === 'reels' ? '#e1306c' : p.platform === 'tiktok' ? '#ee1d52' : '#ff0000';
            const platformLabel = p.platform === 'reels' ? 'Instagram' : p.platform === 'tiktok' ? 'TikTok' : 'YouTube';
            return (
              <Pressable
                key={p.id}
                style={({ pressed }) => [styles.upcomingCard, pressed && { opacity: 0.8 }]}
                onPress={() => router.push('/(tabs)/schedule')}
              >
                <View style={[styles.upcomingThumb, { backgroundColor: platformColor + '22', alignItems: 'center', justifyContent: 'center' }]}>
                  <MaterialIcons name="schedule" size={28} color={platformColor} />
                </View>
                <Text style={styles.upcomingTitle} numberOfLines={2}>{p.title || 'Untitled'}</Text>
                <View style={styles.upcomingMeta}>
                  <MaterialIcons name="schedule" size={11} color={Colors.amber} />
                  <Text style={styles.upcomingDate}>
                    {new Date(p.scheduled_at).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                  </Text>
                </View>
                <View style={styles.upcomingPlatforms}>
                  <Text style={[styles.upcomingDate, { color: platformColor }]}>{platformLabel}</Text>
                </View>
              </Pressable>
            );
          }) : (
            <View style={styles.emptyUpcoming}>
              <MaterialIcons name="video-call" size={32} color={Colors.textMuted} />
              <Text style={styles.emptyText}>No upcoming posts</Text>
            </View>
          )}
        </ScrollView>

        {/* Top Performers */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Top Performers</Text>
          <Pressable onPress={() => router.push('/(tabs)/analytics')}>
            <Text style={styles.seeAll}>Analytics</Text>
          </Pressable>
        </View>
        <View style={styles.performersList}>
          {recentPublished.length === 0 ? (
            <View style={styles.emptyUpcoming}>
              <MaterialIcons name="bar-chart" size={32} color={Colors.textMuted} />
              <Text style={styles.emptyText}>No published videos yet</Text>
            </View>
          ) : recentPublished.map((v, i) => {
            const views = 'metrics' in v ? (v as any).metrics?.views ?? 0 : (v as any).views ?? 0;
            const likes = 'metrics' in v ? (v as any).metrics?.likes ?? 0 : (v as any).likes ?? 0;
            const retention = 'metrics' in v ? (v as any).metrics?.retention : undefined;
            const platform = 'platform' in v ? (v as any).platform : undefined;
            return (
              <View
                key={`${(v as any).platform ?? ''}-${v.id}`}
                style={styles.performerRow}
              >
                <Text style={styles.rank}>#{i + 1}</Text>
                {v.thumbnail ? (
                  <Image source={{ uri: v.thumbnail }} style={styles.performerThumb} contentFit="cover" transition={200} />
                ) : (
                  <View style={[styles.performerThumb, { backgroundColor: Colors.surfaceBorder, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center' }]}>
                    <MaterialIcons name="play-circle-outline" size={18} color={Colors.textMuted} />
                  </View>
                )}
                <View style={styles.performerInfo}>
                  <Text style={styles.performerTitle} numberOfLines={1}>{v.title}</Text>
                  <View style={styles.performerMeta}>
                    {platform && <PlatformBadge platform={platform} size="sm" />}
                    {views > 0 && (
                      <>
                        <MaterialIcons name="visibility" size={11} color={Colors.textMuted} />
                        <Text style={styles.performerViews}>{formatNumber(views)}</Text>
                      </>
                    )}
                    {likes > 0 && (
                      <>
                        <MaterialIcons name="favorite" size={11} color={Colors.pink} />
                        <Text style={styles.performerViews}>{formatNumber(likes)}</Text>
                      </>
                    )}
                    {retention !== undefined && (
                      <>
                        <MaterialIcons name="trending-up" size={11} color={Colors.emerald} />
                        <Text style={styles.performerRetention}>{retention}%</Text>
                      </>
                    )}
                  </View>
                </View>
              </View>
            );
          })}
        </View>

        <View style={{ height: Spacing.xl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  avatarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    flex: 1,
  },
  avatarCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.primaryLight + '60',
  },
  avatarInitials: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: '#fff',
    includeFontPadding: false,
  },
  greeting: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  subGreeting: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
    includeFontPadding: false,
  },
  newBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.full,
  },
  newBtnText: {
    color: '#fff',
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    includeFontPadding: false,
  },
  heroBanner: {
    marginHorizontal: Spacing.md,
    borderRadius: Radius.xl,
    overflow: 'hidden',
    height: 160,
    marginBottom: Spacing.lg,
    backgroundColor: Colors.surfaceElevated,
  },
  heroImage: {
    position: 'absolute',
    width: '100%',
    height: '100%',
  },
  heroOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(8,10,20,0.55)',
    gap: 4,
  },
  heroTitle: {
    fontSize: FontSize.xxxl,
    fontWeight: FontWeight.extrabold,
    color: Colors.textPrimary,
    letterSpacing: 1,
    includeFontPadding: false,
  },
  heroSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
  },
  sectionTitle: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    includeFontPadding: false,
  },
  seeAll: {
    fontSize: FontSize.sm,
    color: Colors.primaryLight,
    fontWeight: FontWeight.semibold,
    includeFontPadding: false,
  },
  statsGrid: {
    paddingHorizontal: Spacing.md,
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  statsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  horizontalScroll: {
    paddingLeft: Spacing.md,
    marginBottom: Spacing.lg,
  },
  upcomingCard: {
    width: 140,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    overflow: 'hidden',
    marginRight: Spacing.sm,
  },
  upcomingThumb: {
    width: '100%',
    height: 100,
  },
  upcomingTitle: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    padding: 8,
    paddingBottom: 4,
    lineHeight: 17,
    includeFontPadding: false,
  },
  upcomingMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingBottom: 6,
  },
  upcomingDate: {
    fontSize: FontSize.xs,
    color: Colors.amber,
    fontWeight: FontWeight.medium,
    includeFontPadding: false,
  },
  upcomingPlatforms: {
    flexDirection: 'row',
    gap: 3,
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  emptyUpcoming: {
    width: width - 32,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
    height: 120,
    gap: 8,
  },
  emptyText: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    includeFontPadding: false,
  },
  performersList: {
    paddingHorizontal: Spacing.md,
    gap: Spacing.xs,
    marginBottom: Spacing.lg,
  },
  performerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    padding: Spacing.sm + 4,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  rank: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.textMuted,
    width: 24,
    includeFontPadding: false,
  },
  performerThumb: {
    width: 44,
    height: 44,
    borderRadius: Radius.sm,
  },
  performerInfo: { flex: 1, gap: 4 },
  performerTitle: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  performerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  performerViews: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    fontWeight: FontWeight.medium,
    includeFontPadding: false,
  },
  performerRetention: {
    fontSize: FontSize.xs,
    color: Colors.emerald,
    fontWeight: FontWeight.semibold,
    includeFontPadding: false,
  },
});
