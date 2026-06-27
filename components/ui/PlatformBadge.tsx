import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MaterialCommunityIcons, FontAwesome5, Entypo } from '@expo/vector-icons';
import { Platform as PlatformType } from '@/types';
import { Colors, Radius, FontSize } from '@/constants/theme';

interface Props {
  platform: PlatformType;
  size?: 'sm' | 'md';
}

const PLATFORM_CONFIG: Record<PlatformType, { label: string; color: string; bg: string }> = {
  tiktok: { label: 'TikTok', color: '#ffffff', bg: '#010101' },
  reels: { label: 'Reels', color: '#ffffff', bg: '#e1306c' },
  youtube: { label: 'YT', color: '#ffffff', bg: '#ff0000' },
};

export default function PlatformBadge({ platform, size = 'md' }: Props) {
  const config = PLATFORM_CONFIG[platform];
  const isSmall = size === 'sm';

  return (
    <View style={[
      styles.badge,
      { backgroundColor: config.bg },
      isSmall ? styles.small : styles.medium,
    ]}>
      <Text style={[
        styles.label,
        { color: config.color, fontSize: isSmall ? FontSize.xs : 12 },
      ]}>
        {isSmall ? config.label.slice(0, 2) : config.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  small: {
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  medium: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  label: {
    fontWeight: '700',
    includeFontPadding: false,
  },
});
