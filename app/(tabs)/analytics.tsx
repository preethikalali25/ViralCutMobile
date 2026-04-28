import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useVideos } from '@/hooks/useVideos';
import { MOCK_ANALYTICS, MOCK_PLATFORM_STATS } from '@/constants/mockData';
import { formatNumber } from '@/services/formatters';
import PlatformBadge from '@/components/ui/PlatformBadge';
import MiniChart from '@/components/ui/MiniChart';

type ChartMetric = 'views' | 'likes' | 'shares';

const METRIC_OPTIONS: { key: ChartMetric; label: string; color: string }[] = [
  { key: 'views', label: 'Views', color: Colors.primary },
  { key: 'likes', label: 'Likes', color: Colors.pink },
  { key: 'shares', label: 'Shares', color: Colors.amber },
];

export default function AnalyticsScreen() {
  const router = useRouter();
  const { videos } = useVideos();
  const [metric, setMetric] = useState<ChartMetric>('views');

  const published = videos.filter(v => v.status === 'published');
  const withMetrics = published.filter(v => v.metrics);

  const totals = withMetrics.reduce(
    (acc, v) => ({
      views: acc.views + (v.metrics?.views ?? 0),
      likes: acc.likes + (v.metrics?.likes ?? 0),
      shares: acc.shares + (v.metrics?.shares ?? 0),
      watchTime: acc.watchTime + (v.metrics?.watchTime ?? 0),
    }),
    { views: 0, likes: 0, shares: 0, watchTime: 0 }
  );

  const avgWatch = withMetrics.length > 0 ? Math.round(totals.watchTime / withMetrics.length) : 0;

  const topVideos = [...withMetrics]
    .sort((a, b) => (b.metrics?.views ?? 0) - (a.metrics?.views ?? 0))
    .slice(0, 5);

  const chartData = MOCK_ANALYTICS.map(d => d[metric]);
  const selectedMetricConfig = METRIC_OPTIONS.find(m => m.key === metric)!;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Analytics</Text>
        <Text style={styles.subtitle}>{published.length} published videos</Text>

        {/* Stats */}
        <View style={styles.statsRow}>
          {[
            { label: 'Total Views', value: formatNumber(totals.views), color: Colors.primary, icon: 'visibility' },
            { label: 'Total Likes', value: formatNumber(totals.likes), color: Colors.pink, icon: 'favorite' },
            { label: 'Shares', value: formatNumber(totals.shares), color: Colors.amber, icon: 'share' },
            { label: 'Avg Watch', value: `${avgWatch}s`, color: Colors.cyan, icon: 'timer' },
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
            <Text style={styles.chartTitle}>Performance Over Time</Text>
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
            {MOCK_ANALYTICS.filter((_, i) => i % 4 === 0).map(d => (
              <Text key={d.date} style={styles.chartLabel}>{d.date}</Text>
            ))}
          </View>
        </View>

        {/* Platform Breakdown */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Platform Breakdown</Text>
          {MOCK_PLATFORM_STATS.map(ps => {
            const maxViews = Math.max(...MOCK_PLATFORM_STATS.map(p => p.views));
            const pct = (ps.views / maxViews) * 100;
            return (
              <View key={ps.platform} style={styles.platformRow}>
                <View style={styles.platformInfo}>
                  <PlatformBadge platform={ps.platform} size="md" />
                  <View style={{ flex: 1, marginLeft: Spacing.sm }}>
                    <View style={styles.platformMeta}>
                      <Text style={styles.platformPosts}>{ps.posts} posts</Text>
                      <Text style={styles.platformRetention}>
                        {ps.avgRetention}% retention
                      </Text>
                    </View>
                    <View style={styles.progressBar}>
                      <View style={[styles.progressFill, { width: `${pct}%`, backgroundColor: Colors.primary }]} />
                    </View>
                  </View>
                  <Text style={styles.platformViews}>{formatNumber(ps.views)}</Text>
                </View>
              </View>
            );
          })}
        </View>

        {/* Top Videos */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Top Performing</Text>
          {topVideos.map((v, i) => (
            <Pressable
              key={v.id}
              style={({ pressed }) => [styles.topVideoRow, pressed && { opacity: 0.8 }]}
              onPress={() => router.push({ pathname: '/editor', params: { id: v.id } })}
            >
              <Text style={styles.topRank}>#{i + 1}</Text>
              <Image source={{ uri: v.thumbnail }} style={styles.topThumb} contentFit="cover" transition={200} />
              <View style={styles.topInfo}>
                <Text style={styles.topTitle} numberOfLines={1}>{v.title}</Text>
                <View style={styles.topMeta}>
                  {v.platforms.slice(0, 1).map(p => <PlatformBadge key={p} platform={p} size="sm" />)}
                  <Text style={styles.topRetention}>{v.metrics!.retention}% ret.</Text>
                </View>
              </View>
              <Text style={styles.topViews}>{formatNumber(v.metrics!.views)}</Text>
            </Pressable>
          ))}
        </View>

        <View style={{ height: Spacing.xl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  title: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    includeFontPadding: false,
  },
  subtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    paddingHorizontal: Spacing.md,
    marginTop: 2,
    marginBottom: Spacing.md,
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
  platformViews: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginLeft: Spacing.sm,
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
  topRetention: {
    fontSize: FontSize.xs,
    color: Colors.emerald,
    fontWeight: FontWeight.semibold,
    includeFontPadding: false,
  },
  topViews: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
});
