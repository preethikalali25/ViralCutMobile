import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator,
  TextInput, Modal, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { Image } from 'expo-image';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import {
  getActiveTemplate, updateClipReplacement, clearClipReplacement, clearActiveTemplate,
} from '@/stores/templateStore';
import { generateSlotImage } from '@/services/templateService';
import { combineMediaToVideo, type MediaItem } from '@/services/videoOverlayService';
import { useVideos } from '@/hooks/useVideos';
import type { TemplateClip } from '@/types/template';
import type { Platform as PlatformType, Video } from '@/types';

type SlotAction = 'idle' | 'replacing' | 'generating';

export default function TemplateEditorScreen() {
  const router = useRouter();
  const { addVideo } = useVideos();
  const template = getActiveTemplate();

  const [clips, setClips] = useState<TemplateClip[]>(template?.clips ?? []);
  const [slotStates, setSlotStates] = useState<Record<string, SlotAction>>({});
  const [generatingClipId, setGeneratingClipId] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [showAiModal, setShowAiModal] = useState(false);
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);

  const setSlotState = (id: string, state: SlotAction) => {
    setSlotStates((prev) => ({ ...prev, [id]: state }));
  };

  const replaceWithMedia = useCallback(async (clipId: string) => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted' && status !== 'limited') {
      Alert.alert('Permission Required', 'Allow access to your media library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: false,
      quality: 1,
    });
    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    const isVideo = asset.type === 'video';
    setSlotState(clipId, 'replacing');

    let previewUri = asset.uri;
    if (isVideo) {
      try {
        const VideoThumbnails = await import('expo-video-thumbnails');
        const { uri } = await VideoThumbnails.getThumbnailAsync(asset.uri, { time: 500, quality: 0.7 });
        previewUri = uri;
      } catch { /* use video uri as fallback */ }
    }

    updateClipReplacement(clipId, asset.uri, isVideo ? 'video' : 'photo');
    setClips((prev) =>
      prev.map((c) =>
        c.id === clipId
          ? { ...c, replacementUri: asset.uri, replacementType: isVideo ? 'video' : 'photo' }
          : c
      )
    );
    setSlotState(clipId, 'idle');
  }, []);

  const openAiGenerator = (clipId: string) => {
    setActiveSlotId(clipId);
    setAiPrompt('');
    setShowAiModal(true);
  };

  const runAiGeneration = async () => {
    if (!activeSlotId || !aiPrompt.trim()) return;
    setShowAiModal(false);
    setGeneratingClipId(activeSlotId);
    setSlotState(activeSlotId, 'generating');

    try {
      const imageUri = await generateSlotImage(aiPrompt.trim());
      updateClipReplacement(activeSlotId, imageUri, 'ai_generated', aiPrompt.trim());
      setClips((prev) =>
        prev.map((c) =>
          c.id === activeSlotId
            ? { ...c, replacementUri: imageUri, replacementType: 'ai_generated', aiGenerationPrompt: aiPrompt.trim() }
            : c
        )
      );
    } catch (e: any) {
      Alert.alert('Generation Failed', e?.message ?? 'Could not generate image. Try again.');
    } finally {
      setSlotState(activeSlotId, 'idle');
      setGeneratingClipId(null);
      setActiveSlotId(null);
    }
  };

  const clearSlot = (clipId: string) => {
    clearClipReplacement(clipId);
    setClips((prev) => prev.map((c) =>
      c.id === clipId
        ? { ...c, replacementUri: undefined, replacementType: undefined, aiGenerationPrompt: undefined }
        : c
    ));
  };

  const filledCount = clips.filter((c) => c.replacementUri).length;
  const allFilled = filledCount === clips.length;

  const buildAndNavigateToEditor = async () => {
    if (filledCount === 0) {
      Alert.alert('No slots filled', 'Replace at least one slot with your own media or an AI-generated image.');
      return;
    }
    setBuilding(true);
    try {
      const mediaList: MediaItem[] = clips
        .filter((c) => c.replacementUri)
        .map((c) => ({
          uri: c.replacementUri!,
          type: c.replacementType === 'video' ? 'video' : 'photo',
        }));

      const id = `v${Date.now()}`;
      const thumbnail = clips[0]?.replacementUri ?? '';
      const totalDur = clips.reduce((s, c) => s + c.duration, 0);

      const videoUri = await combineMediaToVideo(mediaList, 3.0);

      addVideo({
        id, title: '', thumbnail,
        duration: totalDur, status: 'ready',
        platforms: ['tiktok', 'reels'] as PlatformType[],
        createdAt: new Date().toISOString(),
        videoUri,
      } as Video);

      clearActiveTemplate();
      router.push({ pathname: '/editor', params: { id } });
    } catch (e: any) {
      Alert.alert('Build Failed', e?.message ?? 'Could not assemble reel. Try again.');
    } finally {
      setBuilding(false);
    }
  };

  const saveToPhone = async () => {
    if (filledCount === 0) {
      Alert.alert('No slots filled', 'Replace at least one slot before saving.');
      return;
    }
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Allow access to save to your camera roll.');
      return;
    }
    setSaving(true);
    try {
      const mediaList: MediaItem[] = clips
        .filter((c) => c.replacementUri)
        .map((c) => ({
          uri: c.replacementUri!,
          type: c.replacementType === 'video' ? 'video' : 'photo',
        }));

      const videoUri = await combineMediaToVideo(mediaList, 3.0);
      await MediaLibrary.saveToLibraryAsync(videoUri);
      Alert.alert('Saved!', 'Your reel has been saved to your camera roll.');
    } catch (e: any) {
      Alert.alert('Save Failed', e?.message ?? 'Could not save reel. Try again.');
    } finally {
      setSaving(false);
    }
  };

  if (!template) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.errorState}>
          <MaterialIcons name="error-outline" size={44} color={Colors.textMuted} />
          <Text style={styles.errorText}>No template loaded</Text>
          <Pressable style={styles.backLink} onPress={() => router.back()}>
            <Text style={styles.backLinkText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={20} color={Colors.textSecondary} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Template Editor</Text>
          <Text style={styles.headerSub}>
            {filledCount}/{clips.length} slots filled
          </Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>

        {/* Style pill */}
        <View style={styles.stylePill}>
          <MaterialCommunityIcons name="palette" size={14} color={Colors.violet} />
          <Text style={styles.styleText}>
            {template.style.vibe} · {template.style.pacing} pacing · {template.style.musicGenre}
          </Text>
        </View>

        {/* Clip slots grid */}
        <View style={styles.grid}>
          {clips.map((clip) => {
            const state = slotStates[clip.id] ?? 'idle';
            const isGenerating = state === 'generating';
            const hasReplacement = !!clip.replacementUri;

            return (
              <View key={clip.id} style={styles.slot}>
                {/* Thumbnail */}
                <View style={styles.slotThumbContainer}>
                  {isGenerating ? (
                    <View style={[styles.slotThumb, styles.slotThumbLoading]}>
                      <ActivityIndicator color={Colors.primary} />
                      <Text style={styles.generatingLabel}>Generating…</Text>
                    </View>
                  ) : hasReplacement ? (
                    <>
                      <Image
                        source={{ uri: clip.replacementUri! }}
                        style={styles.slotThumb}
                        contentFit="cover"
                      />
                      <View style={styles.replacedBadge}>
                        <MaterialIcons
                          name={clip.replacementType === 'ai_generated' ? 'auto-fix-high' : 'check'}
                          size={10} color="#fff"
                        />
                        <Text style={styles.replacedBadgeText}>
                          {clip.replacementType === 'ai_generated' ? 'AI' : 'Yours'}
                        </Text>
                      </View>
                      <Pressable style={styles.clearBtn} onPress={() => clearSlot(clip.id)}>
                        <MaterialIcons name="close" size={10} color="#fff" />
                      </Pressable>
                    </>
                  ) : (
                    <View style={styles.slotThumbPlaceholder}>
                      <Image
                        source={{ uri: `data:image/jpeg;base64,${clip.originalThumbnail}` }}
                        style={[StyleSheet.absoluteFill, { opacity: 0.35 }]}
                        contentFit="cover"
                      />
                      <View style={styles.slotOverlay}>
                        <MaterialIcons name="add" size={22} color={Colors.primary} />
                      </View>
                    </View>
                  )}

                  {/* Duration badge */}
                  <View style={styles.durationBadge}>
                    <Text style={styles.durationText}>{clip.duration.toFixed(1)}s</Text>
                  </View>

                  {/* Slot number */}
                  <View style={styles.slotIndex}>
                    <Text style={styles.slotIndexText}>{clip.index + 1}</Text>
                  </View>
                </View>

                {/* Description */}
                <Text style={styles.slotDesc} numberOfLines={2}>{clip.description}</Text>
                {clip.textOverlay ? (
                  <Text style={styles.slotTextOverlay} numberOfLines={1}>"{clip.textOverlay}"</Text>
                ) : null}

                {/* Action buttons */}
                {!isGenerating && (
                  <View style={styles.slotActions}>
                    <Pressable
                      style={({ pressed }) => [styles.slotBtn, pressed && { opacity: 0.7 }]}
                      onPress={() => replaceWithMedia(clip.id)}
                    >
                      <MaterialCommunityIcons name="image-plus" size={13} color={Colors.textSecondary} />
                      <Text style={styles.slotBtnText}>Pick</Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [styles.slotBtn, styles.slotBtnAi, pressed && { opacity: 0.7 }]}
                      onPress={() => openAiGenerator(clip.id)}
                    >
                      <MaterialIcons name="auto-fix-high" size={13} color={Colors.violet} />
                      <Text style={[styles.slotBtnText, { color: Colors.violet }]}>AI Gen</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          })}
        </View>

        {/* Bottom actions */}
        <View style={styles.actions}>
          <Pressable
            style={({ pressed }) => [styles.saveBtn, (saving || building) && styles.btnDisabled, pressed && { opacity: 0.85 }]}
            onPress={saveToPhone}
            disabled={saving || building}
          >
            {saving ? (
              <ActivityIndicator size="small" color={Colors.textSecondary} />
            ) : (
              <>
                <MaterialIcons name="save-alt" size={18} color={Colors.textSecondary} />
                <Text style={styles.saveBtnText}>Save to Phone</Text>
              </>
            )}
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.editBtn, (saving || building) && styles.btnDisabled, pressed && { opacity: 0.85 }]}
            onPress={buildAndNavigateToEditor}
            disabled={saving || building}
          >
            {building ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.editBtnText}>Building…</Text>
              </View>
            ) : (
              <>
                <MaterialIcons name="edit" size={18} color="#fff" />
                <Text style={styles.editBtnText}>Add Hook & Publish</Text>
              </>
            )}
          </Pressable>
        </View>

        <View style={{ height: Spacing.xxl }} />
      </ScrollView>

      {/* AI Generation Modal */}
      <Modal
        visible={showAiModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAiModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Generate with AI</Text>
            <Text style={styles.modalSub}>
              Describe the image you want for this slot
            </Text>
            <TextInput
              style={styles.promptInput}
              value={aiPrompt}
              onChangeText={setAiPrompt}
              placeholder="e.g. Morning coffee in a cozy kitchen, warm sunlight, aesthetic"
              placeholderTextColor={Colors.textMuted}
              multiline
              numberOfLines={3}
              autoFocus
            />
            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalCancelBtn}
                onPress={() => setShowAiModal(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalGenerateBtn, !aiPrompt.trim() && styles.btnDisabled]}
                onPress={runAiGeneration}
                disabled={!aiPrompt.trim()}
              >
                <MaterialIcons name="auto-fix-high" size={16} color="#fff" />
                <Text style={styles.modalGenerateText}>Generate</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const SLOT_WIDTH = '47%';

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
  headerCenter: { alignItems: 'center', gap: 2 },
  headerTitle: {
    fontSize: FontSize.lg, fontWeight: FontWeight.bold,
    color: Colors.textPrimary, includeFontPadding: false,
  },
  headerSub: { fontSize: FontSize.xs, color: Colors.textSecondary, includeFontPadding: false },
  scrollContent: { padding: Spacing.md, gap: Spacing.md },
  stylePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.violet + '18', borderRadius: Radius.full,
    paddingVertical: 6, paddingHorizontal: 12, alignSelf: 'flex-start',
    borderWidth: 1, borderColor: Colors.violet + '33',
  },
  styleText: { fontSize: FontSize.xs, color: Colors.violet, includeFontPadding: false },
  grid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between',
  },
  slot: {
    width: SLOT_WIDTH, backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  slotThumbContainer: { width: '100%', aspectRatio: 9 / 16, position: 'relative' },
  slotThumb: { width: '100%', height: '100%' },
  slotThumbLoading: {
    backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  slotThumbPlaceholder: { width: '100%', height: '100%', position: 'relative' },
  slotOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  replacedBadge: {
    position: 'absolute', bottom: 6, left: 6,
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: Colors.primary,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  replacedBadgeText: { fontSize: 9, color: '#fff', fontWeight: FontWeight.bold, includeFontPadding: false },
  clearBtn: {
    position: 'absolute', top: 5, right: 5,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center', justifyContent: 'center',
  },
  durationBadge: {
    position: 'absolute', top: 5, left: 5,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4,
  },
  durationText: { fontSize: 9, color: '#fff', fontWeight: FontWeight.bold, includeFontPadding: false },
  slotIndex: {
    position: 'absolute', bottom: 6, right: 6,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center', justifyContent: 'center',
  },
  slotIndexText: { fontSize: 9, fontWeight: FontWeight.bold, color: '#fff', includeFontPadding: false },
  generatingLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, includeFontPadding: false },
  slotDesc: {
    fontSize: FontSize.xs, color: Colors.textSecondary,
    includeFontPadding: false, padding: 8, lineHeight: 16,
  },
  slotTextOverlay: {
    fontSize: FontSize.xs, color: Colors.amber, fontStyle: 'italic',
    includeFontPadding: false, paddingHorizontal: 8, paddingBottom: 4,
  },
  slotActions: {
    flexDirection: 'row', padding: 8, gap: 6, borderTopWidth: 1, borderTopColor: Colors.surfaceBorder,
  },
  slotBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingVertical: 6,
    backgroundColor: Colors.surface, borderRadius: Radius.sm,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  slotBtnAi: { borderColor: Colors.violet + '55', backgroundColor: Colors.violet + '11' },
  slotBtnText: { fontSize: 11, color: Colors.textSecondary, fontWeight: FontWeight.bold, includeFontPadding: false },
  actions: { gap: Spacing.sm },
  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.full, paddingVertical: 14,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  saveBtnText: {
    fontSize: FontSize.md, fontWeight: FontWeight.bold,
    color: Colors.textSecondary, includeFontPadding: false,
  },
  editBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: Colors.primary,
    borderRadius: Radius.full, paddingVertical: 16,
  },
  editBtnText: {
    fontSize: FontSize.md, fontWeight: FontWeight.bold,
    color: '#fff', includeFontPadding: false,
  },
  btnDisabled: { opacity: 0.4 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: Colors.surfaceElevated,
    borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
    padding: Spacing.lg, gap: Spacing.md,
  },
  modalHandle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: Colors.surfaceBorder, alignSelf: 'center',
  },
  modalTitle: {
    fontSize: FontSize.lg, fontWeight: FontWeight.bold,
    color: Colors.textPrimary, includeFontPadding: false,
  },
  modalSub: { fontSize: FontSize.sm, color: Colors.textSecondary, includeFontPadding: false },
  promptInput: {
    backgroundColor: Colors.surface, borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    padding: Spacing.md, color: Colors.textPrimary,
    fontSize: FontSize.sm, minHeight: 80, textAlignVertical: 'top',
  },
  modalActions: { flexDirection: 'row', gap: Spacing.sm },
  modalCancelBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, borderRadius: Radius.full,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  modalCancelText: {
    fontSize: FontSize.md, fontWeight: FontWeight.bold,
    color: Colors.textSecondary, includeFontPadding: false,
  },
  modalGenerateBtn: {
    flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 14, borderRadius: Radius.full, backgroundColor: Colors.violet,
  },
  modalGenerateText: {
    fontSize: FontSize.md, fontWeight: FontWeight.bold,
    color: '#fff', includeFontPadding: false,
  },
  errorState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  errorText: { fontSize: FontSize.md, color: Colors.textSecondary, includeFontPadding: false },
  backLink: { padding: Spacing.sm },
  backLinkText: { fontSize: FontSize.sm, color: Colors.primary, includeFontPadding: false },
});
