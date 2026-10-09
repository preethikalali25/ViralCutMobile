import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Slider from '@react-native-community/slider';
import { Colors, Spacing, FontSize, FontWeight } from '@/constants/theme';
import { SpeakerSegment } from '@/services/voiceService';
import { speakerColor } from '@/hooks/useVoiceEnhancement';

interface Props {
  segments: SpeakerSegment[];
  volumes: Record<string, number>;
  onVolumeChange: (speaker: string, value: number) => void;
}

export default function SpeakerVolumeSliders({ segments, volumes, onVolumeChange }: Props) {
  const speakers = [...new Set(segments.map(s => s.speaker))].sort();
  if (speakers.length <= 1) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.sectionLabel}>Per-Speaker Volume</Text>
      <Text style={styles.hint}>Adjust how loud each speaker is in the final video.</Text>
      {speakers.map(sp => {
        const color = speakerColor(sp);
        const vol = volumes[sp] ?? 1.0;
        return (
          <View key={sp} style={styles.row}>
            <View style={[styles.speakerBadge, { backgroundColor: color + '22' }]}>
              <Text style={[styles.speakerLabel, { color }]}>Speaker {sp}</Text>
            </View>
            <Slider
              style={styles.slider}
              minimumValue={0}
              maximumValue={1.5}
              step={0.05}
              value={vol}
              onValueChange={v => onVolumeChange(sp, v)}
              minimumTrackTintColor={color}
              maximumTrackTintColor={Colors.surfaceBorder}
              thumbTintColor={color}
            />
            <Text style={[styles.volValue, { color }]}>{Math.round(vol * 100)}%</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: Spacing.md },
  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    color: Colors.textMuted,
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  hint: { fontSize: FontSize.xs, color: Colors.textMuted, marginBottom: Spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.sm },
  speakerBadge: {
    paddingHorizontal: Spacing.sm, paddingVertical: 4,
    borderRadius: 6, minWidth: 84,
  },
  speakerLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, textAlign: 'center' },
  slider: { flex: 1 },
  volValue: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, minWidth: 38, textAlign: 'right' },
});
