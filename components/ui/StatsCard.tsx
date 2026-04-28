import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

interface Props {
  label: string;
  value: string;
  change?: string;
  changeType?: 'up' | 'down' | 'neutral';
  accentColor?: string;
}

export default function StatsCard({ label, value, change, changeType = 'neutral', accentColor = Colors.primary }: Props) {
  const changeColor = changeType === 'up' ? Colors.emerald : changeType === 'down' ? Colors.rose : Colors.textSecondary;

  return (
    <View style={styles.card}>
      <View style={[styles.accentLine, { backgroundColor: accentColor }]} />
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, { color: accentColor }]}>{value}</Text>
      {change ? (
        <Text style={[styles.change, { color: changeColor }]}>
          {changeType === 'up' ? '↑ ' : changeType === 'down' ? '↓ ' : ''}{change}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    gap: 4,
    overflow: 'hidden',
  },
  accentLine: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    borderTopLeftRadius: Radius.md,
    borderTopRightRadius: Radius.md,
  },
  label: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: FontWeight.medium,
    marginTop: 4,
    includeFontPadding: false,
  },
  value: {
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.bold,
    includeFontPadding: false,
  },
  change: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.medium,
    includeFontPadding: false,
  },
});
