import React, { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, FlatList, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useVideos } from '@/hooks/useVideos';
import { VideoStatus } from '@/types';
import VideoCard from '@/components/ui/VideoCard';

type FilterType = 'all' | VideoStatus;

const FILTERS: { label: string; value: FilterType }[] = [
  { label: 'All', value: 'all' },
  { label: 'Published', value: 'published' },
  { label: 'Scheduled', value: 'scheduled' },
  { label: 'Ready', value: 'ready' },
  { label: 'Processing', value: 'processing' },
];

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - Spacing.md * 2 - Spacing.sm) / 2;

export default function LibraryScreen() {
  const router = useRouter();
  const { videos } = useVideos();
  const [filter, setFilter] = useState<FilterType>('all');

  const filtered = useMemo(() =>
    filter === 'all' ? videos : videos.filter(v => v.status === filter),
    [videos, filter]
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Library</Text>
        <Pressable
          style={({ pressed }) => [styles.uploadBtn, pressed && { opacity: 0.8 }]}
          onPress={() => router.push('/upload')}
        >
          <MaterialIcons name="upload" size={18} color="#fff" />
        </Pressable>
      </View>

      {/* Filter Bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}
        contentContainerStyle={styles.filterContent}
      >
        {FILTERS.map(f => (
          <Pressable
            key={f.value}
            style={[styles.filterChip, filter === f.value && styles.filterChipActive]}
            onPress={() => setFilter(f.value)}
          >
            <Text style={[styles.filterLabel, filter === f.value && styles.filterLabelActive]}>
              {f.label}
            </Text>
            {filter === f.value && (
              <Text style={styles.filterCount}>
                {f.value === 'all' ? videos.length : videos.filter(v => v.status === f.value).length}
              </Text>
            )}
          </Pressable>
        ))}
      </ScrollView>

      {/* Grid */}
      {filtered.length > 0 ? (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          numColumns={2}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.gridRow}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <View style={{ width: CARD_WIDTH }}>
              <VideoCard
                video={item}
                onPress={() => router.push({ pathname: '/editor', params: { id: item.id } })}
              />
            </View>
          )}
        />
      ) : (
        <View style={styles.empty}>
          <MaterialIcons name="video-library" size={52} color={Colors.textMuted} />
          <Text style={styles.emptyTitle}>No videos found</Text>
          <Text style={styles.emptySub}>Upload your first video to get started</Text>
          <Pressable
            style={({ pressed }) => [styles.emptyBtn, pressed && { opacity: 0.8 }]}
            onPress={() => router.push('/upload')}
          >
            <Text style={styles.emptyBtnText}>Upload Video</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  uploadBtn: {
    backgroundColor: Colors.primary,
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterScroll: { maxHeight: 52 },
  filterContent: {
    paddingHorizontal: Spacing.md,
    gap: Spacing.sm,
    alignItems: 'center',
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: Radius.full,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  filterChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  filterLabel: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  filterLabelActive: { color: '#fff' },
  filterCount: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: 'rgba(255,255,255,0.8)',
    includeFontPadding: false,
  },
  grid: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
    gap: Spacing.sm,
  },
  gridRow: { gap: Spacing.sm },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: Spacing.xl,
  },
  emptyTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  emptySub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    includeFontPadding: false,
  },
  emptyBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: Radius.full,
    marginTop: 8,
  },
  emptyBtnText: {
    color: '#fff',
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    includeFontPadding: false,
  },
});
