// Web stub for suggest tab — gallery analysis requires native media library access
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, Spacing, FontSize, FontWeight } from '@/constants/theme';

export default function SuggestScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Reel Ideas</Text>
      </View>
      <View style={styles.centeredBox}>
        <MaterialCommunityIcons name="cellphone" size={48} color={Colors.textMuted} />
        <Text style={styles.centeredTitle}>Mobile Only</Text>
        <Text style={styles.centeredSub}>
          Gallery analysis and AI reel suggestions require the mobile app to access your photo library.
          Open ViralCut on your iOS or Android device to use this feature.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.sm,
    borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder,
  },
  headerTitle: {
    fontSize: FontSize.xl, fontWeight: FontWeight.bold,
    color: Colors.textPrimary, includeFontPadding: false,
  },
  centeredBox: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    gap: Spacing.sm, paddingHorizontal: Spacing.xl,
  },
  centeredTitle: {
    fontSize: FontSize.lg, fontWeight: FontWeight.bold,
    color: Colors.textPrimary, includeFontPadding: false, textAlign: 'center',
  },
  centeredSub: {
    fontSize: FontSize.sm, color: Colors.textSecondary,
    textAlign: 'center', includeFontPadding: false, lineHeight: 22,
  },
});
