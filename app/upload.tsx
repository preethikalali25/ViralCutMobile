import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useVideos } from '@/hooks/useVideos';
import { useAlert } from '@/template';
import { Platform as PlatformType } from '@/types';
import PlatformBadge from '@/components/ui/PlatformBadge';

const ALL_PLATFORMS: PlatformType[] = ['tiktok', 'reels', 'youtube'];

const MOCK_THUMBNAILS = [
  'https://images.unsplash.com/photo-1614624532983-4ce03382d63d?w=400&q=80',
  'https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?w=400&q=80',
  'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=400&q=80',
];

export default function UploadScreen() {
  const router = useRouter();
  const { addVideo } = useVideos();
  const { showAlert } = useAlert();
  const [title, setTitle] = useState('');
  const [platforms, setPlatforms] = useState<PlatformType[]>(['tiktok']);
  const [isUploading, setIsUploading] = useState(false);

  const togglePlatform = (p: PlatformType) => {
    setPlatforms(prev =>
      prev.includes(p) ? (prev.length > 1 ? prev.filter(x => x !== p) : prev) : [...prev, p]
    );
  };

  const handleUpload = () => {
    if (!title.trim()) {
      showAlert('Missing Title', 'Please add a title for your video.');
      return;
    }

    setIsUploading(true);
    const thumb = MOCK_THUMBNAILS[Math.floor(Math.random() * MOCK_THUMBNAILS.length)];

    setTimeout(() => {
      const id = `v${Date.now()}`;
      addVideo({
        id,
        title: title.trim(),
        thumbnail: thumb,
        duration: Math.floor(Math.random() * 50) + 15,
        status: 'ready',
        platforms,
        createdAt: new Date().toISOString(),
      });
      setIsUploading(false);
      showAlert('Upload Complete!', 'Your video is ready to edit.', [
        { text: 'Edit Now', onPress: () => router.replace({ pathname: '/editor', params: { id } }) },
        { text: 'Go to Library', style: 'cancel', onPress: () => router.replace('/(tabs)/library') },
      ]);
    }, 2000);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={20} color={Colors.textSecondary} />
        </Pressable>
        <Text style={styles.title}>Upload Video</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Drop Zone */}
        <View style={styles.dropZone}>
          <View style={styles.dropIcon}>
            <MaterialCommunityIcons name="cloud-upload-outline" size={44} color={Colors.primary} />
          </View>
          <Text style={styles.dropTitle}>Select a Video</Text>
          <Text style={styles.dropSub}>MP4, MOV — up to 4GB</Text>
          <View style={styles.dropFormats}>
            {['TikTok', 'Reels', 'YT Shorts'].map(f => (
              <View key={f} style={styles.formatBadge}>
                <Text style={styles.formatText}>{f}</Text>
              </View>
            ))}
          </View>

          <Pressable
            style={({ pressed }) => [styles.selectBtn, pressed && { opacity: 0.8 }]}
            onPress={() => showAlert('File Picker', 'Video picker is available in the native app build.')}
          >
            <MaterialIcons name="video-library" size={18} color="#fff" />
            <Text style={styles.selectBtnText}>Browse Files</Text>
          </Pressable>
        </View>

        {/* Title */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Video Title *</Text>
          <View style={styles.fakeInput}>
            <Pressable
              style={styles.fakeInputPressable}
              onPress={() => showAlert('Enter Title', 'Title input is available in the native app build.', [
                { text: 'Use Mock Title', onPress: () => setTitle('My Amazing Content #' + Math.floor(Math.random() * 100)) },
                { text: 'Cancel', style: 'cancel' },
              ])}
            >
              <Text style={[styles.fakeInputText, !title && { color: Colors.textMuted }]}>
                {title || 'Tap to enter a title...'}
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Platforms */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Target Platforms</Text>
          <View style={styles.platformsList}>
            {ALL_PLATFORMS.map(p => (
              <Pressable
                key={p}
                style={[styles.platformCard, platforms.includes(p) && styles.platformCardActive]}
                onPress={() => togglePlatform(p)}
              >
                <PlatformBadge platform={p} size="md" />
                <Text style={[styles.platformName, platforms.includes(p) && styles.platformNameActive]}>
                  {p === 'tiktok' ? 'TikTok' : p === 'reels' ? 'Instagram Reels' : 'YouTube Shorts'}
                </Text>
                {platforms.includes(p) ? (
                  <MaterialIcons name="check-circle" size={18} color={Colors.primary} />
                ) : (
                  <MaterialIcons name="radio-button-unchecked" size={18} color={Colors.textMuted} />
                )}
              </Pressable>
            ))}
          </View>
        </View>

        {/* Tips */}
        <View style={styles.tipsCard}>
          <View style={styles.tipsHeader}>
            <MaterialIcons name="lightbulb-outline" size={16} color={Colors.amber} />
            <Text style={styles.tipsTitle}>Upload Tips</Text>
          </View>
          <Text style={styles.tipText}>• Vertical 9:16 format works best for all platforms</Text>
          <Text style={styles.tipText}>• Keep it under 60 seconds for max reach</Text>
          <Text style={styles.tipText}>• Upload high resolution (1080p+) for quality</Text>
        </View>

        {/* Upload Button */}
        <Pressable
          style={({ pressed }) => [
            styles.uploadBtn,
            (!title || isUploading) && styles.uploadBtnDisabled,
            pressed && { opacity: 0.85 },
          ]}
          onPress={handleUpload}
          disabled={isUploading}
        >
          {isUploading ? (
            <>
              <MaterialIcons name="hourglass-top" size={20} color="#fff" />
              <Text style={styles.uploadBtnText}>Uploading...</Text>
            </>
          ) : (
            <>
              <MaterialIcons name="cloud-upload" size={20} color="#fff" />
              <Text style={styles.uploadBtnText}>Upload Video</Text>
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 4,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    backgroundColor: Colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  dropZone: {
    margin: Spacing.md,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.xl,
    borderWidth: 2,
    borderColor: Colors.primary + '44',
    borderStyle: 'dashed',
    padding: Spacing.xl,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  dropIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.primaryGlow,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  dropTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  dropSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  dropFormats: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginVertical: 4,
  },
  formatBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: Colors.primaryGlow,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.primary + '44',
  },
  formatText: {
    fontSize: FontSize.xs,
    color: Colors.primaryLight,
    fontWeight: FontWeight.semibold,
    includeFontPadding: false,
  },
  selectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: Radius.full,
    marginTop: 4,
  },
  selectBtnText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: '#fff',
    includeFontPadding: false,
  },
  field: {
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.lg,
    gap: Spacing.sm,
  },
  fieldLabel: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  fakeInput: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    overflow: 'hidden',
  },
  fakeInputPressable: {
    padding: Spacing.sm + 4,
    minHeight: 48,
    justifyContent: 'center',
  },
  fakeInputText: {
    fontSize: FontSize.md,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  platformsList: {
    gap: Spacing.sm,
  },
  platformCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    padding: Spacing.sm + 4,
    borderWidth: 1.5,
    borderColor: Colors.surfaceBorder,
  },
  platformCardActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryGlow,
  },
  platformName: {
    flex: 1,
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  platformNameActive: { color: Colors.textPrimary },
  tipsCard: {
    marginHorizontal: Spacing.md,
    backgroundColor: Colors.amber + '11',
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.amber + '33',
    marginBottom: Spacing.lg,
    gap: Spacing.xs,
  },
  tipsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  tipsTitle: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.amber,
    includeFontPadding: false,
  },
  tipText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  uploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    marginHorizontal: Spacing.md,
    borderRadius: Radius.full,
    paddingVertical: 16,
  },
  uploadBtnDisabled: {
    backgroundColor: Colors.primary + '55',
  },
  uploadBtnText: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: '#fff',
    includeFontPadding: false,
  },
});
