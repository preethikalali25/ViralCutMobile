import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useVideos } from '@/hooks/useVideos';
import { useAlert } from '@/template';
import { Platform as PlatformType, Video } from '@/types';
import PlatformBadge from '@/components/ui/PlatformBadge';

const ALL_PLATFORMS: PlatformType[] = ['tiktok', 'reels', 'youtube'];

/** Try extracting a thumbnail at multiple seek positions to avoid black/dark frames. */
async function extractBestThumbnail(videoUri: string, durationMs: number): Promise<string | null> {
  try {
    const VideoThumbnails = await import('expo-video-thumbnails');
    const dur = durationMs > 0 ? durationMs : 5000;
    const candidates = [
      Math.floor(dur * 0.2),
      Math.floor(dur * 0.1),
      2000,
      1000,
      500,
      0,
    ].filter((t, i, arr) => arr.indexOf(t) === i);

    for (const seekMs of candidates) {
      try {
        const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
          time: seekMs,
          quality: 0.85,
        });
        if (uri) return uri;
      } catch { /* try next */ }
    }
    return null;
  } catch (e) {
    console.warn('Thumbnail extraction failed:', e);
    return null;
  }
}

function getVideoDuration(asset: ImagePicker.ImagePickerAsset): number {
  if (asset.duration && asset.duration > 0) return Math.round(asset.duration);
  return Math.floor(Math.random() * 50) + 15;
}

export default function UploadScreen() {
  const router = useRouter();
  const { addVideo } = useVideos();
  const { showAlert } = useAlert();
  const [platforms, setPlatforms] = useState<PlatformType[]>(['tiktok']);
  const [isUploading, setIsUploading] = useState(false);
  const [pickedVideo, setPickedVideo] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [pickedThumbnail, setPickedThumbnail] = useState<string | null>(null);
  const [extractingThumb, setExtractingThumb] = useState(false);

  const togglePlatform = (p: PlatformType) => {
    setPlatforms(prev =>
      prev.includes(p) ? (prev.length > 1 ? prev.filter(x => x !== p) : prev) : [...prev, p]
    );
  };

  const handlePickVideo = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      showAlert('Permission Required', 'Please allow access to your media library to pick a video.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsEditing: false,
      quality: 1,
    });
    if (!result.canceled && result.assets.length > 0) {
      const asset = result.assets[0];
      setPickedVideo(asset);
      setPickedThumbnail(null);

      if (asset.uri) {
        setExtractingThumb(true);
        extractBestThumbnail(asset.uri, asset.duration ?? 0).then(thumbUri => {
          if (thumbUri) setPickedThumbnail(thumbUri);
          setExtractingThumb(false);
        });
      }
    }
  };

  const handleUpload = async (action: 'edit' | 'publish') => {
    if (!pickedVideo) {
      showAlert('No Video', 'Please select a video first.');
      return;
    }

    setIsUploading(true);
    const id = `v${Date.now()}`;
    const duration = getVideoDuration(pickedVideo);

    let thumb = pickedThumbnail ?? '';
    if (!pickedThumbnail && pickedVideo?.uri) {
      thumb = (await extractBestThumbnail(pickedVideo.uri, pickedVideo.duration ?? 0)) ?? '';
    }

    const newVideo: Video = {
      id,
      title: '',
      thumbnail: thumb,
      duration,
      status: action === 'publish' ? 'published' : 'ready',
      platforms,
      createdAt: new Date().toISOString(),
      ...(action === 'publish' ? { publishedAt: new Date().toISOString() } : {}),
      ...(pickedVideo?.uri ? { videoUri: pickedVideo.uri } : {}),
    };

    addVideo(newVideo);
    setIsUploading(false);

    if (action === 'edit') {
      router.push({ pathname: '/editor', params: { id } });
    } else {
      router.push('/(tabs)/library');
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={20} color={Colors.textSecondary} />
        </Pressable>
        <Text style={styles.headerTitle}>Upload Video</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Drop Zone */}
        <View style={styles.dropZone}>
          {pickedVideo ? (
            <View style={styles.previewWrapper}>
              {pickedThumbnail ? (
                <Image
                  source={{ uri: pickedThumbnail }}
                  style={styles.previewThumb}
                  contentFit="cover"
                  transition={200}
                />
              ) : (
                <View style={[styles.previewThumb, styles.previewPlaceholder]}>
                  {extractingThumb ? (
                    <ActivityIndicator color={Colors.primaryLight} />
                  ) : (
                    <MaterialCommunityIcons name="video" size={36} color={Colors.primaryLight} />
                  )}
                </View>
              )}
              <View style={styles.previewOverlay}>
                <MaterialIcons name="play-circle-filled" size={36} color="rgba(255,255,255,0.85)" />
              </View>
              <Pressable style={styles.previewChange} onPress={handlePickVideo}>
                <MaterialIcons name="swap-horiz" size={14} color={Colors.primaryLight} />
                <Text style={styles.previewChangeText}>Change</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.dropIcon}>
              <MaterialCommunityIcons name="cloud-upload-outline" size={44} color={Colors.primary} />
            </View>
          )}
          <Text style={styles.dropTitle}>{pickedVideo ? 'Video Selected' : 'Select a Video'}</Text>
          <Text style={styles.dropSub}>{pickedVideo ? 'Tap below to change' : 'MP4, MOV — up to 4GB'}</Text>
          {!pickedVideo ? (
            <View style={styles.dropFormats}>
              {['TikTok', 'Reels', 'YT Shorts'].map(f => (
                <View key={f} style={styles.formatBadge}>
                  <Text style={styles.formatText}>{f}</Text>
                </View>
              ))}
            </View>
          ) : null}

          <Pressable
            style={({ pressed }) => [styles.selectBtn, pressed && { opacity: 0.8 }]}
            onPress={handlePickVideo}
          >
            <MaterialIcons name="video-library" size={18} color="#fff" />
            <Text style={styles.selectBtnText}>{pickedVideo ? 'Change Video' : 'Browse Files'}</Text>
          </Pressable>
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

        {/* Action Button */}
        <View style={styles.actionRow}>
          <Pressable
            style={({ pressed }) => [
              styles.editBtn,
              (!pickedVideo || isUploading) && styles.actionBtnDisabled,
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => handleUpload('edit')}
            disabled={!pickedVideo || isUploading}
          >
            {isUploading ? (
              <ActivityIndicator size="small" color={Colors.primaryLight} />
            ) : (
              <>
                <MaterialIcons name="edit" size={18} color={Colors.primaryLight} />
                <Text style={styles.editBtnText}>Edit Now</Text>
              </>
            )}
          </Pressable>
        </View>

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
  headerTitle: {
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
  previewWrapper: {
    width: 120,
    height: 160,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    position: 'relative',
  },
  previewThumb: {
    width: '100%',
    height: '100%',
  },
  previewPlaceholder: {
    backgroundColor: Colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  previewChange: {
    position: 'absolute',
    bottom: 6,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full,
  },
  previewChangeText: {
    fontSize: FontSize.xs,
    color: Colors.primaryLight,
    fontWeight: FontWeight.semibold,
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
  actionRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginHorizontal: Spacing.md,
  },
  editBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.full,
    paddingVertical: 16,
    borderWidth: 1.5,
    borderColor: Colors.primary,
  },
  editBtnText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: Colors.primaryLight,
    includeFontPadding: false,
  },
  actionBtnDisabled: {
    opacity: 0.45,
  },
});
