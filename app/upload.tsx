import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator, FlatList,
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
import { combineMediaToVideo, type MediaItem } from '@/services/videoOverlayService';
import { consumePendingReelItems } from '@/stores/pendingReel';

const ALL_PLATFORMS: PlatformType[] = ['tiktok', 'reels', 'youtube'];

async function requestPermission(): Promise<boolean> {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  return status === 'granted';
}

type MediaPreviewItem = MediaItem & { previewUri: string; durationSec?: number };

const THUMBNAIL_TIMEOUT_MS = 8000;

// '' means "no thumbnail yet" (still loading or failed) — never the raw video
// URI, since <Image> can't render a video file and would show a broken tile.
async function getVideoPreviewUri(uri: string): Promise<string> {
  try {
    const VideoThumbnails = await import('expo-video-thumbnails');
    const result = await Promise.race([
      VideoThumbnails.getThumbnailAsync(uri, { time: 0, quality: 0.7 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('thumbnail timed out')), THUMBNAIL_TIMEOUT_MS)),
    ]);
    return result.uri;
  } catch (e) {
    console.warn('[upload] thumbnail generation failed:', e);
    return '';
  }
}

export default function UploadScreen() {
  const router = useRouter();
  const { addVideo } = useVideos();
  const { showAlert } = useAlert();

  const [platforms, setPlatforms] = useState<PlatformType[]>(['tiktok']);
  const [mediaItems, setMediaItems] = useState<MediaPreviewItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingLabel, setProcessingLabel] = useState('');
  const didConsumeRef = useRef(false);

  const togglePlatform = (p: PlatformType) => {
    setPlatforms(prev =>
      prev.includes(p) ? (prev.length > 1 ? prev.filter(x => x !== p) : prev) : [...prev, p]
    );
  };

  const handleBrowse = async () => {
    if (!(await requestPermission())) {
      showAlert('Permission Required', 'Please allow access to your media library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: 15,
      quality: 1,
    });
    if (!result.canceled) {
      // Add items immediately so the picker doesn't sit blank while thumbnails
      // generate — each video's frame is grabbed in the background and patched
      // into state as it resolves, so one slow/stuck item can't hold up the rest.
      const newItems: MediaPreviewItem[] = result.assets.map(a => {
        const isVideo = a.type === 'video';
        return {
          uri: a.uri,
          type: isVideo ? 'video' : 'photo',
          previewUri: isVideo ? '' : a.uri,
          ...(isVideo ? { durationSec: a.duration ? Math.round(a.duration / 1000) : undefined } : {}),
        };
      });
      setMediaItems(prev => [...prev, ...newItems].slice(0, 15));

      newItems.filter(item => item.type === 'video').forEach(item => {
        getVideoPreviewUri(item.uri).then(previewUri => {
          if (!previewUri) return;
          setMediaItems(prev => {
            const idx = prev.findIndex(m => m.uri === item.uri && !m.previewUri);
            if (idx === -1) return prev;
            const next = [...prev];
            next[idx] = { ...next[idx], previewUri };
            return next;
          });
        });
      });
    }
  };

  const removeItem = (index: number) => {
    setMediaItems(prev => prev.filter((_, i) => i !== index));
  };

  const totalDuration = mediaItems.reduce((sum, item) => {
    if (item.type === 'photo') return sum + 3;
    return sum + Math.min(item.durationSec ?? 15, 15);
  }, 0);

  // Consume pending items from the Suggest screen on first mount and auto-proceed
  useEffect(() => {
    if (didConsumeRef.current) return;
    didConsumeRef.current = true;
    const { items, autoOpen } = consumePendingReelItems();
    if (!items.length) return;
    const loaded: MediaPreviewItem[] = items.map(item => ({
      uri: item.uri, type: item.type,
      previewUri: item.previewUri ?? '', durationSec: item.durationSec,
    }));
    setMediaItems(loaded);
    if (autoOpen) handleEdit(loaded);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEdit = async (overrideItems?: MediaPreviewItem[]) => {
    const items = overrideItems ?? mediaItems;
    if (items.length === 0) {
      showAlert('No Media', 'Add at least one photo or video clip.');
      return;
    }

    setIsProcessing(true);
    const id = `v${Date.now()}`;

    try {
      let videoUri: string;
      let thumbnail = items[0].previewUri;
      if (!thumbnail && items[0].type === 'video') {
        thumbnail = await getVideoPreviewUri(items[0].uri);
      }

      const totalDur = items.reduce((s, m) => s + (m.type === 'photo' ? 3 : Math.min(m.durationSec ?? 15, 15)), 0);

      if (items.length === 1 && items[0].type === 'video') {
        // Single video — pass through directly, no conversion needed
        videoUri = items[0].uri;
        const assetId = items[0].uri.startsWith('ph://')
          ? items[0].uri.replace('ph://', '').split('/')[0]
          : undefined;

        addVideo({
          id, title: '', thumbnail,
          duration: items[0].durationSec ?? 15,
          status: 'ready', platforms,
          createdAt: new Date().toISOString(),
          videoUri,
          ...(assetId ? { videoAssetId: assetId } : {}),
        } as Video);
      } else {
        // Photos, multiple videos, or any mix — combine into one reel
        setProcessingLabel('Creating reel…');
        const mediaList: MediaItem[] = items.map(m => ({ uri: m.uri, type: m.type }));
        videoUri = await combineMediaToVideo(mediaList, 3.0);

        addVideo({
          id, title: '', thumbnail,
          duration: totalDur, status: 'ready', platforms,
          createdAt: new Date().toISOString(),
          videoUri,
        } as Video);
      }
    } catch (e: any) {
      console.warn('[upload] error:', e);
      showAlert('Error', e?.message ?? 'Could not process media. Try again.');
      setIsProcessing(false);
      setProcessingLabel('');
      return;
    }

    setIsProcessing(false);
    setProcessingLabel('');
    router.push({ pathname: '/editor', params: { id } });
  };

  const hasMedia = mediaItems.length > 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={20} color={Colors.textSecondary} />
        </Pressable>
        <Text style={styles.headerTitle}>New Reel</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>

        {/* Media Zone */}
        <View style={styles.dropZone}>
          {hasMedia ? (
            <>
              <FlatList
                data={mediaItems}
                horizontal
                keyExtractor={(_, i) => String(i)}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.strip}
                renderItem={({ item, index }) => (
                  <View style={styles.stripItem}>
                    {item.previewUri ? (
                      <Image source={{ uri: item.previewUri }} style={styles.stripThumb} contentFit="cover" />
                    ) : (
                      <View style={[styles.stripThumb, styles.stripThumbPlaceholder]}>
                        <ActivityIndicator size="small" color={Colors.primary} />
                      </View>
                    )}
                    {item.type === 'video' && (
                      <View style={styles.videoTag}>
                        <MaterialIcons name="videocam" size={10} color="#fff" />
                        {item.durationSec != null
                          ? <Text style={styles.videoTagText}>{Math.min(item.durationSec, 15)}s</Text>
                          : null}
                      </View>
                    )}
                    <Pressable style={styles.removeBtn} onPress={() => removeItem(index)}>
                      <MaterialIcons name="close" size={12} color="#fff" />
                    </Pressable>
                    <View style={styles.stripIndex}>
                      <Text style={styles.stripIndexText}>{index + 1}</Text>
                    </View>
                  </View>
                )}
              />
              <Text style={styles.durationLabel}>
                {mediaItems.length} item{mediaItems.length > 1 ? 's' : ''} · ~{totalDuration}s reel
              </Text>
            </>
          ) : (
            <View style={styles.emptyState}>
              <View style={styles.emptyIcon}>
                <MaterialCommunityIcons name="image-multiple" size={44} color={Colors.primary} />
              </View>
              <Text style={styles.emptyTitle}>Photos & Videos</Text>
              <Text style={styles.emptySub}>Pick any mix — photos, clips, or both</Text>
            </View>
          )}

          <Pressable
            style={({ pressed }) => [styles.browseBtn, pressed && { opacity: 0.8 }]}
            onPress={handleBrowse}
          >
            <MaterialCommunityIcons name="image-multiple-outline" size={18} color="#fff" />
            <Text style={styles.browseBtnText}>
              {hasMedia ? 'Add More' : 'Browse Media'}
            </Text>
          </Pressable>
        </View>

        {/* Tips */}
        <View style={styles.tipsCard}>
          <View style={styles.tipsHeader}>
            <MaterialIcons name="lightbulb-outline" size={16} color={Colors.amber} />
            <Text style={styles.tipsTitle}>Reel Tips</Text>
          </View>
          <Text style={styles.tipText}>• Mix photos and clips — photos show for 3 s each</Text>
          <Text style={styles.tipText}>• Video clips are trimmed to 15 s max per clip</Text>
          <Text style={styles.tipText}>• Tap × on any item to remove it from the reel</Text>
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
                {platforms.includes(p)
                  ? <MaterialIcons name="check-circle" size={18} color={Colors.primary} />
                  : <MaterialIcons name="radio-button-unchecked" size={18} color={Colors.textMuted} />}
              </Pressable>
            ))}
          </View>
        </View>

        {/* Edit Button */}
        <View style={styles.actionRow}>
          <Pressable
            style={({ pressed }) => [
              styles.editBtn,
              (!hasMedia || isProcessing) && styles.actionBtnDisabled,
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => handleEdit()}
            disabled={!hasMedia || isProcessing}
          >
            {isProcessing ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={Colors.primaryLight} />
                <Text style={styles.processingText}>{processingLabel || 'Processing…'}</Text>
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
  dropZone: {
    margin: Spacing.md, backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.xl, borderWidth: 2,
    borderColor: Colors.primary + '44', borderStyle: 'dashed',
    padding: Spacing.lg, alignItems: 'center', gap: Spacing.md,
  },
  emptyState: { alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.sm },
  emptyIcon: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: Colors.primaryGlow, alignItems: 'center', justifyContent: 'center',
  },
  emptyTitle: {
    fontSize: FontSize.lg, fontWeight: FontWeight.bold,
    color: Colors.textPrimary, includeFontPadding: false,
  },
  emptySub: {
    fontSize: FontSize.sm, color: Colors.textSecondary,
    includeFontPadding: false, textAlign: 'center',
  },
  strip: { gap: 8, paddingHorizontal: 4 },
  stripItem: {
    width: 80, height: 106, borderRadius: Radius.md,
    overflow: 'hidden', position: 'relative',
  },
  stripThumb: { width: '100%', height: '100%' },
  stripThumbPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surfaceElevated },
  videoTag: {
    position: 'absolute', bottom: 4, left: 4,
    flexDirection: 'row', alignItems: 'center', gap: 2,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4,
  },
  videoTagText: { fontSize: 9, color: '#fff', fontWeight: FontWeight.bold, includeFontPadding: false },
  removeBtn: {
    position: 'absolute', top: 4, right: 4,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center', justifyContent: 'center',
  },
  stripIndex: {
    position: 'absolute', top: 4, left: 4,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center', justifyContent: 'center',
  },
  stripIndexText: { fontSize: 9, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  durationLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
  browseBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, backgroundColor: Colors.primary,
    paddingVertical: 10, paddingHorizontal: 28, borderRadius: Radius.full,
  },
  browseBtnText: {
    fontSize: FontSize.sm, fontWeight: FontWeight.bold,
    color: '#fff', includeFontPadding: false,
  },
  tipsCard: {
    marginHorizontal: Spacing.md, backgroundColor: Colors.amber + '11',
    borderRadius: Radius.lg, padding: Spacing.md,
    borderWidth: 1, borderColor: Colors.amber + '33',
    marginBottom: Spacing.lg, gap: Spacing.xs,
  },
  tipsHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  tipsTitle: {
    fontSize: FontSize.sm, fontWeight: FontWeight.bold,
    color: Colors.amber, includeFontPadding: false,
  },
  tipText: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
  field: { paddingHorizontal: Spacing.md, marginBottom: Spacing.lg, gap: Spacing.sm },
  fieldLabel: {
    fontSize: FontSize.sm, fontWeight: FontWeight.semibold,
    color: Colors.textSecondary, includeFontPadding: false,
  },
  platformsList: { gap: Spacing.sm },
  platformCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md,
    padding: Spacing.sm + 4, borderWidth: 1.5, borderColor: Colors.surfaceBorder,
  },
  platformCardActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryGlow },
  platformName: {
    flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.semibold,
    color: Colors.textSecondary, includeFontPadding: false,
  },
  platformNameActive: { color: Colors.textPrimary },
  actionRow: { marginHorizontal: Spacing.md },
  editBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.full, paddingVertical: 16,
    borderWidth: 1.5, borderColor: Colors.primary,
  },
  editBtnText: {
    fontSize: FontSize.md, fontWeight: FontWeight.bold,
    color: Colors.primaryLight, includeFontPadding: false,
  },
  actionBtnDisabled: { opacity: 0.45 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  processingText: {
    fontSize: FontSize.md, fontWeight: FontWeight.semibold,
    color: Colors.primaryLight, includeFontPadding: false,
  },
});
