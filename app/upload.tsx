import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator, FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useVideos } from '@/hooks/useVideos';
import { useAlert } from '@/template';
import { Platform as PlatformType, Video } from '@/types';
import PlatformBadge from '@/components/ui/PlatformBadge';
import { photosToVideo } from '@/services/videoOverlayService';

const ALL_PLATFORMS: PlatformType[] = ['tiktok', 'reels', 'youtube'];

type Mode = 'video' | 'photos';

/** Copy a ph:// asset to the local cache so expo-video-thumbnails can read it. */
async function resolveVideoUri(uri: string): Promise<string> {
  if (!uri.startsWith('ph://')) return uri;

  try {
    const FS = await import('expo-file-system');
    const dest = FS.cacheDirectory + `vid_${Date.now()}.mp4`;
    await FS.copyAsync({ from: uri, to: dest });
    return dest;
  } catch (e) {
    console.warn('[resolveVideoUri] copyAsync failed, trying MediaLibrary:', e);
  }

  try {
    const MediaLibrary = await import('expo-media-library');
    const assetId = uri.replace('ph://', '').split('/')[0];
    const asset = await MediaLibrary.getAssetInfoAsync(assetId);
    if (asset?.localUri) return asset.localUri;
  } catch (e) {
    console.warn('[resolveVideoUri] MediaLibrary fallback failed:', e);
  }

  return uri;
}

/** Try extracting a thumbnail at multiple seek positions to avoid black/dark frames. */
async function extractBestThumbnail(videoUri: string, durationMs: number): Promise<string | null> {
  try {
    const resolvedUri = await resolveVideoUri(videoUri);
    const dur = durationMs > 0 ? durationMs : 5000;
    const candidates = [
      Math.floor(dur * 0.2), Math.floor(dur * 0.1), 2000, 1000, 500, 0,
    ].filter((t, i, arr) => arr.indexOf(t) === i);

    for (const seekMs of candidates) {
      try {
        const { uri } = await VideoThumbnails.getThumbnailAsync(resolvedUri, {
          time: seekMs, quality: 0.85,
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

  const [mode, setMode] = useState<Mode>('video');
  const [platforms, setPlatforms] = useState<PlatformType[]>(['tiktok']);
  const [isUploading, setIsUploading] = useState(false);
  const [convertingPhotos, setConvertingPhotos] = useState(false);

  // Video mode state
  const [pickedVideo, setPickedVideo] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [pickedThumbnail, setPickedThumbnail] = useState<string | null>(null);
  const [extractingThumb, setExtractingThumb] = useState(false);

  // Photos mode state
  const [pickedPhotos, setPickedPhotos] = useState<ImagePicker.ImagePickerAsset[]>([]);

  const togglePlatform = (p: PlatformType) => {
    setPlatforms(prev =>
      prev.includes(p) ? (prev.length > 1 ? prev.filter(x => x !== p) : prev) : [...prev, p]
    );
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setPickedVideo(null);
    setPickedThumbnail(null);
    setPickedPhotos([]);
  };

  const handlePickVideo = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      showAlert('Permission Required', 'Please allow access to your media library.');
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
        }).catch(() => setExtractingThumb(false));
      }
    }
  };

  const handlePickPhotos = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      showAlert('Permission Required', 'Please allow access to your media library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 1,
    });
    if (!result.canceled && result.assets.length > 0) {
      setPickedPhotos(result.assets);
    }
  };

  const handleUpload = async (action: 'edit' | 'publish') => {
    if (mode === 'video' && !pickedVideo) {
      showAlert('No Video', 'Please select a video first.');
      return;
    }
    if (mode === 'photos' && pickedPhotos.length === 0) {
      showAlert('No Photos', 'Please select at least one photo.');
      return;
    }

    setIsUploading(true);
    const id = `v${Date.now()}`;

    try {
      if (mode === 'photos') {
        // Convert photos to a video reel
        setConvertingPhotos(true);
        const photoUris = pickedPhotos.map(p => p.uri);
        const videoUri = await photosToVideo(photoUris, 3.0);
        setConvertingPhotos(false);

        const duration = pickedPhotos.length * 3;
        const thumbnail = pickedPhotos[0].uri; // first photo as thumbnail

        const newVideo: Video = {
          id,
          title: '',
          thumbnail,
          duration,
          status: action === 'publish' ? 'published' : 'ready',
          platforms,
          createdAt: new Date().toISOString(),
          videoUri,
          ...(action === 'publish' ? { publishedAt: new Date().toISOString() } : {}),
        };

        addVideo(newVideo);
      } else {
        // Video mode
        const duration = getVideoDuration(pickedVideo!);
        let thumb = pickedThumbnail ?? '';
        if (!thumb && pickedVideo?.uri) {
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
          ...(pickedVideo?.assetId ? { videoAssetId: pickedVideo.assetId } : {}),
        };

        addVideo(newVideo);
      }
    } catch (e: any) {
      console.warn('[upload] handleUpload error:', e);
      showAlert('Error', e?.message ?? 'Something went wrong. Please try again.');
      setIsUploading(false);
      setConvertingPhotos(false);
      return;
    }

    setIsUploading(false);

    if (action === 'edit') {
      router.push({ pathname: '/editor', params: { id } });
    } else {
      router.push('/(tabs)/library');
    }
  };

  const hasContent = mode === 'video' ? !!pickedVideo : pickedPhotos.length > 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={20} color={Colors.textSecondary} />
        </Pressable>
        <Text style={styles.headerTitle}>New Reel</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Mode Toggle */}
        <View style={styles.modeRow}>
          <Pressable
            style={[styles.modeBtn, mode === 'video' && styles.modeBtnActive]}
            onPress={() => switchMode('video')}
          >
            <MaterialIcons
              name="videocam"
              size={16}
              color={mode === 'video' ? Colors.primaryLight : Colors.textMuted}
            />
            <Text style={[styles.modeBtnText, mode === 'video' && styles.modeBtnTextActive]}>
              Video
            </Text>
          </Pressable>
          <Pressable
            style={[styles.modeBtn, mode === 'photos' && styles.modeBtnActive]}
            onPress={() => switchMode('photos')}
          >
            <MaterialIcons
              name="photo-library"
              size={16}
              color={mode === 'photos' ? Colors.primaryLight : Colors.textMuted}
            />
            <Text style={[styles.modeBtnText, mode === 'photos' && styles.modeBtnTextActive]}>
              Photos
            </Text>
          </Pressable>
        </View>

        {/* Drop Zone */}
        <View style={styles.dropZone}>
          {mode === 'video' ? (
            <>
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
              {!pickedVideo && (
                <View style={styles.dropFormats}>
                  {['TikTok', 'Reels', 'YT Shorts'].map(f => (
                    <View key={f} style={styles.formatBadge}>
                      <Text style={styles.formatText}>{f}</Text>
                    </View>
                  ))}
                </View>
              )}
              <Pressable
                style={({ pressed }) => [styles.selectBtn, pressed && { opacity: 0.8 }]}
                onPress={handlePickVideo}
              >
                <MaterialIcons name="video-library" size={18} color="#fff" />
                <Text style={styles.selectBtnText}>{pickedVideo ? 'Change Video' : 'Browse Files'}</Text>
              </Pressable>
            </>
          ) : (
            <>
              {/* Photos mode */}
              {pickedPhotos.length > 0 ? (
                <View style={styles.photoStripContainer}>
                  <FlatList
                    data={pickedPhotos}
                    horizontal
                    keyExtractor={(_, i) => String(i)}
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.photoStrip}
                    renderItem={({ item, index }) => (
                      <View style={styles.photoThumbWrapper}>
                        <Image
                          source={{ uri: item.uri }}
                          style={styles.photoThumb}
                          contentFit="cover"
                        />
                        <View style={styles.photoIndex}>
                          <Text style={styles.photoIndexText}>{index + 1}</Text>
                        </View>
                      </View>
                    )}
                  />
                </View>
              ) : (
                <View style={styles.dropIcon}>
                  <MaterialIcons name="photo-library" size={44} color={Colors.primary} />
                </View>
              )}
              <Text style={styles.dropTitle}>
                {pickedPhotos.length > 0
                  ? `${pickedPhotos.length} Photo${pickedPhotos.length > 1 ? 's' : ''} Selected`
                  : 'Select Photos'}
              </Text>
              <Text style={styles.dropSub}>
                {pickedPhotos.length > 0
                  ? `Each shown for 3s · ${pickedPhotos.length * 3}s total`
                  : 'Pick up to 10 photos — we\'ll make a reel'}
              </Text>
              <Pressable
                style={({ pressed }) => [styles.selectBtn, pressed && { opacity: 0.8 }]}
                onPress={handlePickPhotos}
              >
                <MaterialIcons name="add-photo-alternate" size={18} color="#fff" />
                <Text style={styles.selectBtnText}>
                  {pickedPhotos.length > 0 ? 'Change Photos' : 'Choose Photos'}
                </Text>
              </Pressable>
            </>
          )}
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
            <Text style={styles.tipsTitle}>
              {mode === 'photos' ? 'Photo Reel Tips' : 'Upload Tips'}
            </Text>
          </View>
          {mode === 'photos' ? (
            <>
              <Text style={styles.tipText}>• Pick 3–8 photos for the best reel length</Text>
              <Text style={styles.tipText}>• Photos are shown in the order you select them</Text>
              <Text style={styles.tipText}>• Add a hook and background music in the editor</Text>
            </>
          ) : (
            <>
              <Text style={styles.tipText}>• Vertical 9:16 format works best for all platforms</Text>
              <Text style={styles.tipText}>• Keep it under 60 seconds for max reach</Text>
              <Text style={styles.tipText}>• Upload high resolution (1080p+) for quality</Text>
            </>
          )}
        </View>

        {/* Action Button */}
        <View style={styles.actionRow}>
          <Pressable
            style={({ pressed }) => [
              styles.editBtn,
              (!hasContent || isUploading) && styles.actionBtnDisabled,
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => handleUpload('edit')}
            disabled={!hasContent || isUploading}
          >
            {isUploading ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={Colors.primaryLight} />
                {convertingPhotos && (
                  <Text style={styles.convertingText}>Creating reel…</Text>
                )}
              </View>
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
  modeRow: {
    flexDirection: 'row',
    marginHorizontal: Spacing.md,
    marginTop: Spacing.md,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.full,
    padding: 3,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  modeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: Radius.full,
  },
  modeBtnActive: {
    backgroundColor: Colors.primaryGlow,
    borderWidth: 1,
    borderColor: Colors.primary + '55',
  },
  modeBtnText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textMuted,
    includeFontPadding: false,
  },
  modeBtnTextActive: {
    color: Colors.primaryLight,
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
    textAlign: 'center',
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
  previewThumb: { width: '100%', height: '100%' },
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
  // Photos mode
  photoStripContainer: { width: '100%' },
  photoStrip: { gap: 8, paddingHorizontal: 4 },
  photoThumbWrapper: {
    width: 80,
    height: 100,
    borderRadius: Radius.md,
    overflow: 'hidden',
    position: 'relative',
  },
  photoThumb: { width: '100%', height: '100%' },
  photoIndex: {
    position: 'absolute',
    top: 4,
    left: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoIndexText: {
    fontSize: 10,
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
  platformsList: { gap: Spacing.sm },
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
    marginHorizontal: Spacing.md,
  },
  editBtn: {
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
  actionBtnDisabled: { opacity: 0.45 },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  convertingText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
    color: Colors.primaryLight,
    includeFontPadding: false,
  },
});
