import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, FontSize, FontWeight } from '@/constants/theme';
import { SpeakerSegment, computeSpeakerStats } from '@/services/voiceService';
import { speakerColor } from '@/hooks/useVoiceEnhancement';

interface Props {
  segments: SpeakerSegment[];
  durationMs: number;
}

export default function SpeakerTimeline({ segments, durationMs }: Props) {
  if (!segments.length || !durationMs) return null;

  const stats = computeSpeakerStats(segments);
  const speakers = Object.keys(stats).sort();

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Speaker Timeline</Text>

      {/* Timeline bar */}
      <View style={styles.timelineBar}>
        {segments.map((seg, i) => {
          const left = (seg.start / durationMs) * 100;
          const width = ((seg.end - seg.start) / durationMs) * 100;
          return (
            <View
              key={i}
              style={[
                styles.segment,
                {
                  left: `${left}%` as any,
                  width: `${Math.max(width, 0.5)}%` as any,
                  backgroundColor: speakerColor(seg.speaker),
                },
              ]}
            />
          );
        })}
      </View>

      {/* Speaker chips */}
      <View style={styles.chips}>
        {speakers.map(sp => (
          <View key={sp} style={styles.chip}>
            <View style={[styles.chipDot, { backgroundColor: speakerColor(sp) }]} />
            <Text style={styles.chipText}>
              Speaker {sp} · {stats[sp].percent}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: Spacing.md },
  label: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    color: Colors.textMuted,
    marginBottom: Spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  timelineBar: {
    height: 24,
    backgroundColor: Colors.surfaceBorder,
    borderRadius: 6,
    overflow: 'hidden',
    position: 'relative',
    marginBottom: Spacing.sm,
  },
  segment: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderRadius: 2,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  chipDot: { width: 10, height: 10, borderRadius: 5 },
  chipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
});
