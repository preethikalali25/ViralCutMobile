import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { formatNumber } from '@/services/formatters';
import { useAnalytics } from '@/hooks/useAnalytics';
import { MOCK_ANALYTICS, MOCK_PLATFORM_STATS } from '@/constants/mockData';
import PlatformBadge from '@/components/ui/PlatformBadge';
import MiniChart from '@/components/ui/MiniChart';
import { Platform } from '@/types';

type ChartMetric = 'views' | 'likes' | 'shares';

const METRIC_OPTIONS: { key: ChartMetric; label: string; color: string }[] = [
  { key: 'views', label: 'Views', color: Colors.primary },
  { key: 'likes', label: 'Likes', color: Colors.pink },
  { key: 'shares', label: 'Shares', color: Colors.amber },
];

const PLATFORM_COLORS: Record<Platform, string> = {
  tiktok: Colors.primary,
  reels: Colors.pink,
  youtube: Colors.rose ?? Colors.pink,
};

export default function AnalyticsScreen() {
  const router = useRouter();
  const [metric, setMetric] = useState<ChartMetric>('views');
  const { data, loading, error, refresh, lastFetched } = useAnalytics();

  const hasRealData = !!data && data.platforms.some(p => p.connected && p.posts > 0);

  // Totals
  const totals = hasRealData
    ? { views: data!.totalViews, likes: data!.totalLikes, shares: data!.totalShares, watchTime: 0 }
    : { views: 0, likes: 0, shares: 0, watchTime: 0 };

  // Platform breakdown
  const platformStats = hasRealData
    ? data!.platforms.filter(p => p.connected).map(p => ({
        platform: p.platform,
        posts: p.posts,
        views: p.totalViews,
        likes: p.totalLikes,
        avgRetention: 0,
      }))
    : MOCK_PLATFORM_STATS;

  // Chart data
  const chartPoints = hasRealData ? data!.chartData : MOCK_ANALYTICS;
  const chartData = chartPoints.map(d => d[metric]);
  const selectedMetricConfig = METRIC_OPTIONS.find(m => m.key === metric)!;

  // Top videos
  const topVideos = hasRealData ? data!.topVideos.slice(0, 5) : [];

  const publishedCount = hasRealData ? data!.platforms.reduce((s, p) => s + p.posts, 0) : 0;

  const lastUpdated = lastFetched
    ? new Date(lastFetched).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.titleRow}>
          <View>
            <Text style={styles.title}>Analytics</Text>
            <Text style={styles.subtitle}>
              {hasRealData ? `${publishedCount} videos across platforms` : 'Connect platforms to see real data'}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.refreshBtn, pressed && { opacity: 0.6 }]}
            onPress={refresh}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator size="small" color={Colors.primary} />
              : <MaterialIcons name="refresh" size={20} color={Colors.primary} />
            }
          </Pressable>
        </View>

        {lastUpdated && (
          <Text style={styles.lastUpdated}>Updated {lastUpdated}</Text>
        )}

        {error && (
          <View style={styles.errorBanner}>
            <MaterialIcons name="error-outline" size={14} color={Colors.rose ?? Colors.pink} />
            <Text style={styles.errorText}>Some platforms failed to load</Text>
          </View>
        )}

        {/* Platform connection notices */}
        {data && data.platforms.map(p => p.needsReconnect && (
          <Pressable
            key={p.platform}
            style={styles.reconnectBanner}
            onPress={() => router.push('/profile')}
          >
            <PlatformBadge platform={p.platform} size="sm" />
            <Text style={styles.reconnectText}>Reconnect {p.platform} to enable analytics</Text>
            <MaterialIcons name="chevron-right" size={16} color={Colors.amber} />
          </Pressable>
        ))}

        {/* Stats */}
        <View style={styles.statsRow}>
          {[
            { label: 'Total Views', value: formatNumber(totals.views), color: Colors.primary, icon: 'visibility' },
            { label: 'Total Likes', value: formatNumber(totals.likes), color: Colors.pink, icon: 'favorite' },
            { label: 'Shares', value: formatNumber(totals.shares), color: Colors.amber, icon: 'share' },
            { label: 'Posts', value: String(publishedCount), color: Colors.cyan, icon: 'video-library' },
          ].map(s => (
            <View key={s.label} style={styles.statCard}>
              <MaterialIcons name={s.icon as any} size={18} color={s.color} />
              <Text style={[styles.statValue, { color: s.color }]}>{s.value}</Text>
              <Text style={styles.statLabel}>{s.label}</Text>
            </View>
          ))}
        </View>

        {/* Chart */}
        <View style={styles.chartCard}>
          <View style={styles.chartHeader}>
            <Text style={styles.chartTitle}>
              {hasRealData ? 'Video Performance by Publish Week' : 'Performance Over Time'}
            </Text>
            <View style={styles.metricTabs}>
              {METRIC_OPTIONS.map(m => (
                <Pressable
                  key={m.key}
                  style={[styles.metricTab, metric === m.key && { backgroundColor: m.color + '22', borderColor: m.color }]}
                  onPress={() => setMetric(m.key)}
                >
                  <Text style={[styles.metricTabLabel, metric === m.key && { color: m.color }]}>
                    {m.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <MiniChart data={chartData} color={selectedMetricConfig.color} height={80} />

          <View style={styles.chartLabels}>
            {chartPoints.filter((_, i) => i % 2 === 0).map(d => (
              <Text key={d.date} style={styles.chartLabel}>{d.date}</Text>
            ))}
          </View>
        </View>

        {/* Platform Breakdown */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Platform Breakdown</Text>
          {platformStats.length === 0 ? (
            <Pressable style={styles.connectPrompt} onPress={() => router.push('/profile')}>
              <MaterialIcons name="link" size={20} color={Colors.primary} />
              <Text style={styles.connectText}>Connect social accounts to see breakdown</Text>
            </Pressable>
          ) : (() => {
            const maxEngagement = Math.max(...platformStats.map(p => p.views + p.likes));
            return platformStats.map(ps => {
              const engagement = ps.views + ps.likes;
              const pct = maxEngagement > 0 ? (engagement / maxEngagement) * 100 : 0;
              const barColor = PLATFORM_COLORS[ps.platform] ?? Colors.primary;
              return (
                <View key={ps.platform} style={styles.platformRow}>
                  <View style={styles.platformInfo}>
                    <PlatformBadge platform={ps.platform} size="md" />
                    <View style={{ flex: 1, marginLeft: Spacing.sm }}>
                      <View style={styles.platformMeta}>
                        <Text style={styles.platformPosts}>{ps.posts} posts</Text>
                        {ps.avgRetention > 0 && (
                          <Text style={styles.platformRetention}>{ps.avgRetention}% retention</Text>
                        )}
                      </View>
                      <View style={styles.progressBar}>
                        <View style={[styles.progressFill, { width: `${pct}%`, backgroundColor: barColor }]} />
                      </View>
                    </View>
                    <View style={styles.platformNumbers}>
                      {ps.views > 0 && <Text style={styles.platformViews}>{formatNumber(ps.views)}</Text>}
                      {ps.likes > 0 && (
                        <Text style={styles.platformLikes}>
                          <MaterialIcons name="favorite" size={10} color={Colors.pink} /> {formatNumber(ps.likes)}
                        </Text>
                      )}
                    </View>
                  </View>
                </View>
              );
            });
          })()}
        </View>

        {/* Top Videos */}
        {topVideos.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Top Performing</Text>
            {topVideos.map((v, i) => (
              <View key={`${v.platform}-${v.id}`} style={styles.topVideoRow}>
                <Text style={styles.topRank}>#{i + 1}</Text>
                {v.thumbnail ? (
                  <Image source={{ uri: v.thumbnail }} style={styles.topThumb} contentFit="cover" transition={200} />
                ) : (
                  <View style={[styles.topThumb, styles.topThumbPlaceholder]}>
                    <MaterialIcons name="play-circle-outline" size={20} color={Colors.textMuted} />
                  </View>
                )}
                <View style={styles.topInfo}>
                  <Text style={styles.topTitle} numberOfLines={1}>{v.title}</Text>
                  <View style={styles.topMeta}>
                    <PlatformBadge platform={v.platform} size="sm" />
                    {v.views > 0 && (
                      <Text style={styles.topViews}>{formatNumber(v.views)} views</Text>
                    )}
                    {v.likes > 0 && (
                      <Text style={styles.topLikes}>{formatNumber(v.likes)} likes</Text>
                    )}
                  </View>
                </View>
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
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  subtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
    marginBottom: Spacing.md,
    includeFontPadding: false,
  },
  refreshBtn: {
    padding: 6,
    marginTop: 2,
  },
  lastUpdated: {
    fontSize: 10,
    color: Colors.textMuted,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    includeFontPadding: false,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    backgroundColor: Colors.rose ? Colors.rose + '20' : Colors.pink + '20',
    padding: Spacing.sm,
    borderRadius: Radius.sm,
  },
  errorText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  reconnectBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    backgroundColor: Colors.amber + '20',
    padding: Spacing.sm,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.amber + '40',
  },
  reconnectText: {
    flex: 1,
    fontSize: FontSize.sm,
    color: Colors.amber,
    includeFontPadding: false,
  },
  statsRow: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.md,
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  statCard: {
    flex: 1,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  statValue: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    includeFontPadding: false,
  },
  statLabel: {
    fontSize: 10,
    color: Colors.textSecondary,
    textAlign: 'center',
    includeFontPadding: false,
  },
  chartCard: {
    marginHorizontal: Spacing.md,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    marginBottom: Spacing.lg,
  },
  chartHeader: {
    marginBottom: Spacing.md,
    gap: Spacing.sm,
  },
  chartTitle: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  metricTabs: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  metricTab: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    backgroundColor: 'transparent',
  },
  metricTabLabel: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  chartLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.sm,
  },
  chartLabel: {
    fontSize: 10,
    color: Colors.textMuted,
    includeFontPadding: false,
  },
  section: {
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.lg,
    gap: Spacing.sm,
  },
  sectionTitle: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  connectPrompt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderStyle: 'dashed',
  },
  connectText: {
    fontSize: FontSize.sm,
    color: Colors.primary,
    flex: 1,
    includeFontPadding: false,
  },
  platformRow: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    padding: Spacing.sm + 4,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  platformInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  platformMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  platformPosts: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  platformRetention: {
    fontSize: FontSize.sm,
    color: Colors.emerald,
    fontWeight: FontWeight.semibold,
    includeFontPadding: false,
  },
  progressBar: {
    height: 5,
    backgroundColor: Colors.surfaceBorder,
    borderRadius: Radius.full,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: Radius.full,
  },
  platformNumbers: {
    alignItems: 'flex-end',
    marginLeft: Spacing.sm,
    gap: 2,
  },
  platformViews: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  platformLikes: {
    fontSize: FontSize.xs,
    color: Colors.pink,
    includeFontPadding: false,
  },
  topVideoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    padding: Spacing.sm + 4,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  topRank: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.textMuted,
    width: 24,
    includeFontPadding: false,
  },
  topThumb: {
    width: 44,
    height: 44,
    borderRadius: Radius.sm,
  },
  topThumbPlaceholder: {
    backgroundColor: Colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topInfo: { flex: 1, gap: 4 },
  topTitle: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  topMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  topViews: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  topLikes: {
    fontSize: FontSize.xs,
    color: Colors.pink,
    includeFontPadding: false,
  },
});
