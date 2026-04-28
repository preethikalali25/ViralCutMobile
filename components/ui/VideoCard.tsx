import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { MaterialIcons } from '@expo/vector-icons';
import { Video } from '@/types';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import PlatformBadge from './PlatformBadge';
import StatusBadge from './StatusBadge';
import { formatNumber, formatDuration } from '@/services/formatters';

interface Props {
  video: Video;
  onPress: () => void;
}

export default function VideoCard({ video, onPress }: Props) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
      onPress={onPress}
    >
      <View style={styles.thumbnailWrapper}>
        <Image
          source={{ uri: video.thumbnail }}
          style={styles.thumbnail}
          contentFit="cover"
          transition={200}
        />
        <View style={styles.durationBadge}>
          <Text style={styles.duration}>{formatDuration(video.duration)}</Text>
        </View>
        <View style={styles.playOverlay}>
          <MaterialIcons name="play-circle-filled" size={32} color="rgba(255,255,255,0.9)" />
        </View>
      </View>

      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={2}>{video.title}</Text>

        <View style={styles.row}>
          <StatusBadge status={video.status} />
          <View style={styles.platforms}>
            {video.platforms.map(p => (
              <PlatformBadge key={p} platform={p} size="sm" />
            ))}
          </View>
        </View>

        {video.metrics ? (
          <View style={styles.metricsRow}>
            <View style={styles.metric}>
              <MaterialIcons name="visibility" size={11} color={Colors.textMuted} />
              <Text style={styles.metricVal}>{formatNumber(video.metrics.views)}</Text>
            </View>
            <View style={styles.metric}>
              <MaterialIcons name="favorite" size={11} color={Colors.textMuted} />
              <Text style={styles.metricVal}>{formatNumber(video.metrics.likes)}</Text>
            </View>
            <View style={styles.metric}>
              <MaterialIcons name="trending-up" size={11} color={Colors.emerald} />
              <Text style={[styles.metricVal, { color: Colors.emerald }]}>{video.metrics.retention}%</Text>
            </View>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    overflow: 'hidden',
  },
  thumbnailWrapper: {
    position: 'relative',
    aspectRatio: 9 / 14,
    backgroundColor: Colors.surface,
  },
  thumbnail: {
    width: '100%',
    height: '100%',
  },
  durationBadge: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: Radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  duration: {
    color: '#fff',
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    includeFontPadding: false,
  },
  playOverlay: {
    position: 'absolute',
    inset: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    padding: Spacing.sm + 4,
    gap: 6,
  },
  title: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    lineHeight: 18,
    includeFontPadding: false,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  platforms: {
    flexDirection: 'row',
    gap: 3,
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  metric: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  metricVal: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    fontWeight: FontWeight.medium,
    includeFontPadding: false,
  },
});
