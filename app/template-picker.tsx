import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { analyzeReelTemplate } from '@/services/templateService';
import { setActiveTemplate } from '@/stores/templateStore';

export default function TemplatePickerScreen() {
  const router = useRouter();
  const [selectedUri, setSelectedUri] = useState<string | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState('');

  const pickReel = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted' && status !== 'limited') {
      Alert.alert('Permission Required', 'Allow access to your media library to pick a reel.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsMultipleSelection: false,
      quality: 1,
    });
    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    setSelectedUri(asset.uri);
    setDurationSec(asset.duration ? asset.duration / 1000 : 30);

    // Generate preview thumbnail
    try {
      const VideoThumbnails = await import('expo-video-thumbnails');
      const { uri } = await VideoThumbnails.getThumbnailAsync(asset.uri, {
        time: 500, quality: 0.8,
      });
      setPreviewUri(uri);
    } catch {
      setPreviewUri(asset.uri);
    }
  };

  const analyzeTemplate = async () => {
    if (!selectedUri) return;
    setAnalyzing(true);
    try {
      setProgress('Extracting frames…');
      const template = await analyzeReelTemplate(selectedUri, durationSec);
      setActiveTemplate(template);
      setProgress('');
      setAnalyzing(false);
      router.push('/template-editor');
    } catch (e: any) {
      setAnalyzing(false);
      setProgress('');
      Alert.alert('Analysis Failed', e?.message ?? 'Could not analyze the reel. Try again.');
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={20} color={Colors.textSecondary} />
        </Pressable>
        <Text style={styles.headerTitle}>Use as Template</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={styles.body}>
        {/* How it works */}
        <View style={styles.howItWorks}>
          <Text style={styles.sectionLabel}>How it works</Text>
          <View style={styles.steps}>
            {[
              { icon: 'download', label: 'Save a Reel to your camera roll from Instagram, TikTok, or Shorts' },
              { icon: 'video-library', label: 'Pick that video here — AI will detect each clip slot' },
              { icon: 'auto-fix-high', label: 'Replace each slot with your own photos, videos, or AI-generated images' },
              { icon: 'save-alt', label: 'Render your reel and save to your phone' },
            ].map((step, i) => (
              <View key={i} style={styles.step}>
                <View style={styles.stepIcon}>
                  <MaterialIcons name={step.icon as any} size={16} color={Colors.primary} />
                </View>
                <Text style={styles.stepText}>{step.label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Video picker zone */}
        <Pressable
          style={({ pressed }) => [styles.pickZone, pressed && { opacity: 0.8 }]}
          onPress={pickReel}
        >
          {previewUri ? (
            <View style={styles.previewContainer}>
              <Image source={{ uri: previewUri }} style={styles.preview} contentFit="cover" />
              <View style={styles.previewOverlay}>
                <MaterialIcons name="check-circle" size={28} color={Colors.primary} />
                <Text style={styles.previewLabel}>
                  {Math.round(durationSec)}s reel selected
                </Text>
                <Text style={styles.previewChange}>Tap to change</Text>
              </View>
            </View>
          ) : (
            <View style={styles.pickEmpty}>
              <View style={styles.pickIcon}>
                <MaterialCommunityIcons name="video-plus" size={44} color={Colors.primary} />
              </View>
              <Text style={styles.pickTitle}>Pick a Reel</Text>
              <Text style={styles.pickSub}>Choose a saved video from your camera roll</Text>
            </View>
          )}
        </Pressable>

        <View style={styles.analyzeRow}>
          <Pressable
            style={({ pressed }) => [
              styles.analyzeBtn,
              (!selectedUri || analyzing) && styles.btnDisabled,
              pressed && { opacity: 0.85 },
            ]}
            onPress={analyzeTemplate}
            disabled={!selectedUri || analyzing}
          >
            {analyzing ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={Colors.primaryLight} />
                <Text style={styles.analyzeBtnText}>{progress || 'Analyzing…'}</Text>
              </View>
            ) : (
              <>
                <MaterialIcons name="auto-fix-high" size={18} color={Colors.primaryLight} />
                <Text style={styles.analyzeBtnText}>Analyze Template</Text>
              </>
            )}
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm + 4,
    borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: Radius.full,
    backgroundColor: Colors.surfaceElevated, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  headerTitle: {
    fontSize: FontSize.lg, fontWeight: FontWeight.bold,
    color: Colors.textPrimary, includeFontPadding: false,
  },
  body: { flex: 1, padding: Spacing.md, gap: Spacing.md },
  howItWorks: {
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.xl,
    padding: Spacing.md, borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  sectionLabel: {
    fontSize: FontSize.xs, fontWeight: FontWeight.bold,
    color: Colors.primary, textTransform: 'uppercase',
    letterSpacing: 1, marginBottom: Spacing.sm, includeFontPadding: false,
  },
  steps: { gap: 10 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  stepIcon: {
    width: 28, height: 28, borderRadius: Radius.full,
    backgroundColor: Colors.primaryGlow, alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  stepText: {
    flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary,
    lineHeight: 20, includeFontPadding: false,
  },
  pickZone: {
    flex: 1, backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.xl, borderWidth: 2,
    borderColor: Colors.primary + '44', borderStyle: 'dashed',
    overflow: 'hidden',
  },
  pickEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm },
  pickIcon: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: Colors.primaryGlow, alignItems: 'center', justifyContent: 'center',
  },
  pickTitle: {
    fontSize: FontSize.xl, fontWeight: FontWeight.bold,
    color: Colors.textPrimary, includeFontPadding: false,
  },
  pickSub: {
    fontSize: FontSize.sm, color: Colors.textSecondary,
    textAlign: 'center', paddingHorizontal: Spacing.xl, includeFontPadding: false,
  },
  previewContainer: { flex: 1 },
  preview: { flex: 1 },
  previewOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  previewLabel: {
    fontSize: FontSize.md, fontWeight: FontWeight.bold,
    color: '#fff', includeFontPadding: false,
  },
  previewChange: {
    fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false,
  },
  analyzeRow: {},
  analyzeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: Colors.primary,
    borderRadius: Radius.full, paddingVertical: 16,
  },
  analyzeBtnText: {
    fontSize: FontSize.md, fontWeight: FontWeight.bold,
    color: '#fff', includeFontPadding: false,
  },
  btnDisabled: { opacity: 0.4 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
