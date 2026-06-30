import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator,
} from 'react-native';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useAuth } from '@/template';
import { useVoiceEnhancement } from '@/hooks/useVoiceEnhancement';
import { uploadVideoToStorage } from '@/services/tiktokService';
import SpeakerTimeline from './SpeakerTimeline';
import SpeakerVolumeSliders from './SpeakerVolumeSliders';

interface Props {
  videoId: string;
  videoPublicUrl: string | undefined;
  videoDurationMs: number;
  /** Called when a mixed output URL is ready — parent uses this for scheduling/publish */
  onMixReady?: (outputUrl: string) => void;
}

const PHASE_LABELS: Record<string, string> = {
  submitting: 'Starting analysis…',
  analyzing: 'Detecting speakers…',
  mixing: 'Applying speaker mix…',
};

export default function VoiceTab({ videoId, videoPublicUrl, videoDurationMs, onMixReady }: Props) {
  const { user } = useAuth();
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(
    videoPublicUrl?.startsWith('http') ? videoPublicUrl : undefined,
  );
  const [uploading, setUploading] = useState(false);

  // If videoPublicUrl is a local path, resolve ph:// then upload to get a public HTTP URL
  useEffect(() => {
    if (!videoPublicUrl || videoPublicUrl.startsWith('http') || !user?.id) return;
    setUploading(true);
    (async () => {
      try {
        let uri = videoPublicUrl;
        // Resolve ph:// Photos library URIs to a readable file path
        if (uri.startsWith('ph://')) {
          try {
            const FS = await import('expo-file-system');
            const dest = FS.cacheDirectory + `voice_${videoId}_${Date.now()}.mp4`;
            await FS.copyAsync({ from: uri, to: dest });
            uri = dest;
          } catch {
            const MediaLibrary = await import('expo-media-library');
            const assetId = uri.replace('ph://', '').split('/')[0];
            const asset = await MediaLibrary.getAssetInfoAsync(assetId);
            if (asset?.localUri) uri = asset.localUri;
          }
        }
        const { publicUrl } = await uploadVideoToStorage(uri, user.id, videoId);
        if (publicUrl) setResolvedUrl(publicUrl);
      } catch (e) {
        console.warn('[VoiceTab] failed to resolve/upload video:', e);
      } finally {
        setUploading(false);
      }
    })();
  }, [videoPublicUrl, videoId, user?.id]);

  const {
    state, speakerVolumes, setSpeakerVolumes,
    analyze, applyMix, loadCached, reset,
  } = useVoiceEnhancement(videoId, resolvedUrl);

  useEffect(() => {
    loadCached();
  }, [loadCached]);

  useEffect(() => {
    if (state.phase === 'mix-ready' && state.mixOutputUrl) {
      onMixReady?.(state.mixOutputUrl);
    }
  }, [state.phase, state.mixOutputUrl]);

  const isProcessing = ['submitting', 'analyzing', 'enhancing', 'mixing'].includes(state.phase);
  const phaseLabel = PHASE_LABELS[state.phase] ?? '';

  return (
    <View style={styles.container}>

      {/* Header card */}
      <View style={styles.headerCard}>
        <MaterialCommunityIcons name="waveform" size={22} color={Colors.primaryLight} />
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>AI Voice Enhancement</Text>
          <Text style={styles.headerSub}>
            Detects multiple speakers, cleans up audio, and lets you adjust each voice independently.
          </Text>
        </View>
      </View>

      {/* Idle — show analyze button (or uploading spinner) */}
      {state.phase === 'idle' && (
        uploading ? (
          <View style={styles.processingCard}>
            <ActivityIndicator size="small" color={Colors.primaryLight} />
            <Text style={styles.processingLabel}>Preparing video…</Text>
          </View>
        ) : !resolvedUrl ? (
          <View style={styles.errorCard}>
            <MaterialIcons name="error-outline" size={20} color="#ef4444" />
            <Text style={styles.errorText}>Could not prepare video for analysis. Try saving the video first.</Text>
          </View>
        ) : (
          <Pressable
            style={({ pressed }) => [styles.analyzeBtn, pressed && { opacity: 0.85 }]}
            onPress={() => analyze()}
          >
            <MaterialIcons name="record-voice-over" size={18} color="#fff" />
            <Text style={styles.analyzeBtnText}>Analyze Voice & Speakers</Text>
          </Pressable>
        )
      )}

      {/* Processing spinner */}
      {isProcessing && (
        <View style={styles.processingCard}>
          <ActivityIndicator size="large" color={Colors.primaryLight} />
          <Text style={styles.processingLabel}>{phaseLabel}</Text>
          <Text style={styles.processingSub}>This may take 30–90 seconds</Text>
        </View>
      )}

      {/* Error state */}
      {state.phase === 'error' && (
        <View style={styles.errorCard}>
          <MaterialIcons name="error-outline" size={20} color="#ef4444" />
          <Text style={styles.errorText}>{state.errorMessage ?? 'Something went wrong'}</Text>
          <Pressable onPress={reset} style={styles.retryBtn}>
            <Text style={styles.retryText}>Try Again</Text>
          </Pressable>
        </View>
      )}

      {/* Ready — show results */}
      {(state.phase === 'ready' || state.phase === 'mixing' || state.phase === 'mix-ready') && state.enhancement && (
        <>
          {/* Speaker count summary */}
          <View style={styles.summaryRow}>
            <View style={styles.summaryChip}>
              <MaterialIcons name="people" size={15} color={Colors.primaryLight} />
              <Text style={styles.summaryText}>
                {state.enhancement.speakerCount} speaker{state.enhancement.speakerCount !== 1 ? 's' : ''} detected
              </Text>
            </View>
          </View>

          {/* Speaker timeline */}
          <SpeakerTimeline
            segments={state.enhancement.speakerSegments}
            durationMs={videoDurationMs || 60000}
          />

          {/* Per-speaker volume sliders (Phase 2 — only if multiple speakers) */}
          {state.enhancement.speakerCount > 1 && (
            <>
              <SpeakerVolumeSliders
                segments={state.enhancement.speakerSegments}
                volumes={speakerVolumes}
                onVolumeChange={(sp, v) =>
                  setSpeakerVolumes(prev => ({ ...prev, [sp]: v }))
                }
              />

              {/* Apply mix button */}
              {state.phase === 'ready' && (
                <Pressable
                  style={({ pressed }) => [styles.mixBtn, pressed && { opacity: 0.85 }]}
                  onPress={applyMix}
                >
                  <MaterialCommunityIcons name="equalizer" size={18} color="#fff" />
                  <Text style={styles.mixBtnText}>Apply Speaker Mix</Text>
                </Pressable>
              )}

              {/* Mix ready */}
              {state.phase === 'mix-ready' && (
                <View style={styles.mixReadyCard}>
                  <MaterialIcons name="check-circle" size={18} color="#10b981" />
                  <Text style={styles.mixReadyText}>
                    Speaker mix applied — this audio will be used when publishing.
                  </Text>
                </View>
              )}
            </>
          )}

          <Pressable onPress={() => { reset(); }} style={styles.reanalyzeBtn}>
            <Text style={styles.reanalyzeText}>Re-analyze</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  headerCard: {
    flexDirection: 'row', gap: Spacing.sm, alignItems: 'flex-start',
    backgroundColor: Colors.surface, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  headerTitle: { fontSize: FontSize.md, fontWeight: FontWeight.semibold, color: Colors.text, marginBottom: 2 },
  headerSub: { fontSize: FontSize.xs, color: Colors.textMuted, lineHeight: 16 },
  analyzeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    backgroundColor: Colors.primary, borderRadius: Radius.md,
    paddingVertical: Spacing.md, marginBottom: Spacing.md,
  },
  analyzeBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  processingCard: {
    alignItems: 'center', gap: Spacing.sm, padding: Spacing.xl,
    backgroundColor: Colors.surface, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.surfaceBorder, marginBottom: Spacing.md,
  },
  processingLabel: { fontSize: FontSize.md, fontWeight: FontWeight.semibold, color: Colors.text },
  processingSub: { fontSize: FontSize.xs, color: Colors.textMuted },
  errorCard: {
    alignItems: 'center', gap: Spacing.sm, padding: Spacing.lg,
    backgroundColor: '#ef444415', borderRadius: Radius.md,
    borderWidth: 1, borderColor: '#ef4444', marginBottom: Spacing.md,
  },
  errorText: { fontSize: FontSize.sm, color: '#ef4444', textAlign: 'center' },
  retryBtn: { paddingHorizontal: Spacing.md, paddingVertical: 6, borderRadius: Radius.sm, backgroundColor: '#ef444422' },
  retryText: { fontSize: FontSize.sm, color: '#ef4444', fontWeight: FontWeight.semibold },
  summaryRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md, flexWrap: 'wrap' },
  summaryChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: Colors.surface, borderRadius: Radius.sm,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    paddingHorizontal: Spacing.sm, paddingVertical: 5,
  },
  summaryText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: FontWeight.semibold },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  toggleLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.text },
  toggleSub: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 2 },
  mixBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    backgroundColor: '#6366f1', borderRadius: Radius.md,
    paddingVertical: Spacing.md, marginBottom: Spacing.md,
  },
  mixBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  mixReadyCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: '#10b98115', borderRadius: Radius.md,
    borderWidth: 1, borderColor: '#10b981',
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  mixReadyText: { flex: 1, fontSize: FontSize.sm, color: '#10b981' },
  reanalyzeBtn: { alignItems: 'center', paddingVertical: Spacing.sm, marginBottom: Spacing.md },
  reanalyzeText: { fontSize: FontSize.sm, color: Colors.textMuted },
});
