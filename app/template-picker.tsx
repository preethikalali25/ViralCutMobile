import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator, Alert, TextInput, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import {
  analyzeReelTemplate, resolveReelUrl, downloadVideoToCache,
} from '@/services/templateService';
import { setActiveTemplate } from '@/stores/templateStore';

type Tab = 'link' | 'library';

export default function TemplatePickerScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('link');

  // Link tab state
  const [reelUrl, setReelUrl] = useState('');
  const [urlError, setUrlError] = useState('');

  // Library tab state
  const [selectedUri, setSelectedUri] = useState<string | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState(0);

  // Shared
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

    try {
      const VideoThumbnails = await import('expo-video-thumbnails');
      const { uri } = await VideoThumbnails.getThumbnailAsync(asset.uri, { time: 500, quality: 0.8 });
      setPreviewUri(uri);
    } catch {
      setPreviewUri(asset.uri);
    }
  };

  const validateUrl = (url: string): boolean => {
    const trimmed = url.trim();
    if (!trimmed) { setUrlError('Paste a Reel link first.'); return false; }
    const isValid =
      trimmed.includes('instagram.com') ||
      trimmed.includes('instagr.am') ||
      trimmed.includes('tiktok.com') ||
      trimmed.includes('vm.tiktok.com') ||
      trimmed.includes('youtube.com/shorts') ||
      trimmed.includes('youtu.be');
    if (!isValid) {
      setUrlError('Paste an Instagram, TikTok, or YouTube Shorts link.');
      return false;
    }
    setUrlError('');
    return true;
  };

  const analyzeFromLink = async () => {
    if (!validateUrl(reelUrl)) return;
    setAnalyzing(true);
    try {
      setProgress('Resolving link…');
      const { videoUrl, durationSec: dur, thumbnail } = await resolveReelUrl(reelUrl.trim());

      setProgress('Downloading reel…');
      const { localUri } = await downloadVideoToCache(videoUrl);

      const totalDur = dur ?? 30;
      setProgress('Extracting frames…');
      const template = await analyzeReelTemplate(localUri, totalDur);
      setActiveTemplate(template);
      setAnalyzing(false);
      setProgress('');
      router.push('/template-editor');
    } catch (e: any) {
      setAnalyzing(false);
      setProgress('');
      Alert.alert('Failed', e?.message ?? 'Could not analyze this reel. Try again.');
    }
  };

  const analyzeFromLibrary = async () => {
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

  const canAnalyze = tab === 'link' ? !!reelUrl.trim() : !!selectedUri;
  const onAnalyze = tab === 'link' ? analyzeFromLink : analyzeFromLibrary;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={20} color={Colors.textSecondary} />
        </Pressable>
        <Text style={styles.headerTitle}>Use as Template</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>

        {/* Tab switcher */}
        <View style={styles.tabs}>
          <Pressable
            style={[styles.tab, tab === 'link' && styles.tabActive]}
            onPress={() => setTab('link')}
          >
            <MaterialIcons name="link" size={15} color={tab === 'link' ? Colors.primary : Colors.textSecondary} />
            <Text style={[styles.tabText, tab === 'link' && styles.tabTextActive]}>Paste Link</Text>
          </Pressable>
          <Pressable
            style={[styles.tab, tab === 'library' && styles.tabActive]}
            onPress={() => setTab('library')}
          >
            <MaterialCommunityIcons name="image-multiple" size={15} color={tab === 'library' ? Colors.primary : Colors.textSecondary} />
            <Text style={[styles.tabText, tab === 'library' && styles.tabTextActive]}>Camera Roll</Text>
          </Pressable>
        </View>

        {/* Link tab */}
        {tab === 'link' && (
          <View style={styles.linkSection}>
            <Text style={styles.sectionLabel}>Paste a Reel link</Text>
            <Text style={styles.sectionSub}>
              Works with Instagram Reels, TikTok videos, and YouTube Shorts
            </Text>

            <View style={styles.inputRow}>
              <MaterialIcons name="link" size={18} color={Colors.textMuted} style={styles.inputIcon} />
              <TextInput
                style={styles.urlInput}
                value={reelUrl}
                onChangeText={(t) => { setReelUrl(t); setUrlError(''); }}
                placeholder="https://www.instagram.com/reel/..."
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                onSubmitEditing={onAnalyze}
              />
              {reelUrl.length > 0 && (
                <Pressable onPress={() => { setReelUrl(''); setUrlError(''); }}>
                  <MaterialIcons name="close" size={16} color={Colors.textMuted} />
                </Pressable>
              )}
            </View>
            {urlError ? <Text style={styles.errorText}>{urlError}</Text> : null}

            {/* Platform badges */}
            <View style={styles.platformRow}>
              {[
                { name: 'Instagram', color: '#e1306c', icon: 'movie' },
                { name: 'TikTok', color: '#010101', icon: 'music-video' },
                { name: 'YT Shorts', color: '#ff0000', icon: 'smart-display' },
              ].map((p) => (
                <View key={p.name} style={[styles.platformBadge, { borderColor: p.color + '55' }]}>
                  <MaterialIcons name={p.icon as any} size={12} color={p.color} />
                  <Text style={[styles.platformBadgeText, { color: p.color }]}>{p.name}</Text>
                </View>
              ))}
            </View>

            <View style={styles.noteCard}>
              <MaterialIcons name="info-outline" size={14} color={Colors.amber} />
              <Text style={styles.noteText}>
                Make sure the reel is <Text style={{ color: Colors.textPrimary }}>public</Text> and save it to your camera roll first if the link doesn't resolve.
              </Text>
            </View>
          </View>
        )}

        {/* Library tab */}
        {tab === 'library' && (
          <View style={styles.librarySection}>
            <Text style={styles.sectionLabel}>Pick a saved Reel</Text>
            <Text style={styles.sectionSub}>
              Save any Reel to your camera roll first, then pick it here
            </Text>

            <Pressable
              style={({ pressed }) => [styles.pickZone, pressed && { opacity: 0.8 }]}
              onPress={pickReel}
            >
              {previewUri ? (
                <View style={styles.previewContainer}>
                  <Image source={{ uri: previewUri }} style={styles.preview} contentFit="cover" />
                  <View style={styles.previewOverlay}>
                    <MaterialIcons name="check-circle" size={28} color={Colors.primary} />
                    <Text style={styles.previewLabel}>{Math.round(durationSec)}s reel selected</Text>
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
          </View>
        )}

        {/* Analyze button */}
        <Pressable
          style={({ pressed }) => [
            styles.analyzeBtn,
            (!canAnalyze || analyzing) && styles.btnDisabled,
            pressed && { opacity: 0.85 },
          ]}
          onPress={onAnalyze}
          disabled={!canAnalyze || analyzing}
        >
          {analyzing ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={styles.analyzeBtnText}>{progress || 'Analyzing…'}</Text>
            </View>
          ) : (
            <>
              <MaterialIcons name="auto-fix-high" size={18} color="#fff" />
              <Text style={styles.analyzeBtnText}>Analyze Template</Text>
            </>
          )}
        </Pressable>

        <View style={{ height: Spacing.xl }} />
      </ScrollView>
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
  body: { padding: Spacing.md, gap: Spacing.md },
  tabs: {
    flexDirection: 'row', backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg, padding: 4,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  tab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 10, borderRadius: Radius.md,
  },
  tabActive: { backgroundColor: Colors.primaryGlow },
  tabText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: FontWeight.bold, includeFontPadding: false },
  tabTextActive: { color: Colors.primary },
  sectionLabel: {
    fontSize: FontSize.md, fontWeight: FontWeight.bold,
    color: Colors.textPrimary, includeFontPadding: false,
  },
  sectionSub: {
    fontSize: FontSize.sm, color: Colors.textSecondary,
    includeFontPadding: false, lineHeight: 20,
  },
  linkSection: { gap: Spacing.sm },
  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    paddingHorizontal: Spacing.md, gap: 8, minHeight: 52,
  },
  inputIcon: { flexShrink: 0 },
  urlInput: {
    flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary,
    includeFontPadding: false, paddingVertical: 14,
  },
  errorText: { fontSize: FontSize.xs, color: Colors.error, includeFontPadding: false },
  platformRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  platformBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderRadius: Radius.full,
    paddingHorizontal: 10, paddingVertical: 4,
    backgroundColor: Colors.surfaceElevated,
  },
  platformBadgeText: { fontSize: 11, fontWeight: FontWeight.bold, includeFontPadding: false },
  noteCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: Colors.amber + '11', borderRadius: Radius.md,
    padding: Spacing.sm, borderWidth: 1, borderColor: Colors.amber + '33',
  },
  noteText: { flex: 1, fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 18, includeFontPadding: false },
  librarySection: { gap: Spacing.sm },
  pickZone: {
    height: 220, backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.xl, borderWidth: 2,
    borderColor: Colors.primary + '44', borderStyle: 'dashed',
    overflow: 'hidden',
  },
  pickEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm },
  pickIcon: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: Colors.primaryGlow, alignItems: 'center', justifyContent: 'center',
  },
  pickTitle: {
    fontSize: FontSize.lg, fontWeight: FontWeight.bold,
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
  previewLabel: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  previewChange: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
  analyzeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: Colors.primary,
    borderRadius: Radius.full, paddingVertical: 16,
  },
  analyzeBtnText: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  btnDisabled: { opacity: 0.4 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
