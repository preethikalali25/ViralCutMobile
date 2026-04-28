import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, Radius } from '@/constants/theme';

interface Props {
  data: number[];
  color?: string;
  height?: number;
}

export default function MiniChart({ data, color = Colors.primary, height = 48 }: Props) {
  if (!data.length) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;

  return (
    <View style={[styles.container, { height }]}>
      {data.map((val, i) => {
        const barHeight = ((val - min) / range) * height * 0.85 + height * 0.1;
        const isLast = i === data.length - 1;
        return (
          <View
            key={i}
            style={[
              styles.bar,
              {
                height: barHeight,
                backgroundColor: isLast ? color : color + '55',
                flex: 1,
                borderRadius: 3,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    overflow: 'hidden',
  },
  bar: {},
});
