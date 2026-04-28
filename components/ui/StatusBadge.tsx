import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { VideoStatus } from '@/types';
import { Colors, Radius, FontSize } from '@/constants/theme';
import { getStatusColor, getStatusLabel } from '@/services/formatters';

interface Props {
  status: VideoStatus;
}

export default function StatusBadge({ status }: Props) {
  const color = getStatusColor(status);
  const label = getStatusLabel(status);

  return (
    <View style={[styles.badge, { backgroundColor: color + '22', borderColor: color + '44' }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  label: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    includeFontPadding: false,
  },
});
