import { useState, useCallback, useRef } from 'react';
import { useAuth } from '@/template';
import {
  SpeakerSegment,
  VoiceEnhancement,
  submitVoiceAnalysis,
  pollTranscript,
  getCachedEnhancement,
  submitMixJob,
  pollMixJob,
} from '@/services/voiceService';

export type VoicePhase =
  | 'idle'
  | 'submitting'
  | 'analyzing'    // waiting for AssemblyAI
  | 'enhancing'    // waiting for Dolby.io
  | 'ready'
  | 'mixing'       // per-speaker mix job running
  | 'mix-ready'
  | 'error';

export interface VoiceState {
  phase: VoicePhase;
  enhancement: VoiceEnhancement | null;
  mixOutputUrl: string | null;
  errorMessage: string | null;
}

const SPEAKER_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6'];

export function speakerColor(speaker: string): string {
  const idx = speaker.charCodeAt(0) - 65; // A=0, B=1, …
  return SPEAKER_COLORS[idx % SPEAKER_COLORS.length];
}

export function useVoiceEnhancement(videoId: string, videoPublicUrl: string | undefined) {
  const { user } = useAuth();
  const [state, setState] = useState<VoiceState>({
    phase: 'idle',
    enhancement: null,
    mixOutputUrl: null,
    errorMessage: null,
  });
  const [speakerVolumes, setSpeakerVolumes] = useState<Record<string, number>>({});

  const transcriptPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mixPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (transcriptPollRef.current) clearInterval(transcriptPollRef.current);
    if (mixPollRef.current) clearInterval(mixPollRef.current);
  }, []);

  /** Load cached enhancement from DB (call on Voice tab open). */
  const loadCached = useCallback(async () => {
    if (!user?.id || !videoId) return;
    const { enhancement } = await getCachedEnhancement(videoId, user.id);
    if (!enhancement) return;
    setState(prev => ({
      ...prev,
      phase: enhancement.status === 'ready' ? 'ready' : 'idle',
      enhancement: enhancement.status === 'ready' ? enhancement : null,
    }));
    if (enhancement.status === 'ready') {
      const speakers = [...new Set(enhancement.speakerSegments.map(s => s.speaker))];
      setSpeakerVolumes(prev => {
        const next = { ...prev };
        for (const sp of speakers) { if (!(sp in next)) next[sp] = 1.0; }
        return next;
      });
    }
  }, [user?.id, videoId]);

  /** Start voice analysis (Phase 1). */
  const analyze = useCallback(async (speakersExpected?: number) => {
    if (!user?.id || !videoPublicUrl) return;
    setState({ phase: 'submitting', enhancement: null, mixOutputUrl: null, errorMessage: null });

    const { enhancementId, transcriptId, error } = await submitVoiceAnalysis(
      videoId, user.id, videoPublicUrl, speakersExpected,
    );

    if (error || !enhancementId || !transcriptId) {
      setState(prev => ({ ...prev, phase: 'error', errorMessage: error ?? 'Submission failed' }));
      return;
    }

    setState(prev => ({ ...prev, phase: 'analyzing' }));

    // Poll AssemblyAI transcript
    transcriptPollRef.current = setInterval(async () => {
      const { data, error: pollErr } = await pollTranscript(transcriptId, enhancementId);
      if (pollErr) return;
      if (data?.status === 'completed') {
        clearInterval(transcriptPollRef.current!);
        const enhancement: VoiceEnhancement = {
          id: enhancementId,
          speakerCount: data.speakerCount ?? 0,
          speakerSegments: data.speakerSegments ?? [],
          enhancedUrl: null,
          status: 'ready',
        };
        const speakers = [...new Set((data.speakerSegments as SpeakerSegment[] ?? []).map(s => s.speaker))];
        setSpeakerVolumes(prev => {
          const next = { ...prev };
          for (const sp of speakers) { if (!(sp in next)) next[sp] = 1.0; }
          return next;
        });
        setState(prev => ({ ...prev, phase: 'ready', enhancement }));
      } else if (data?.status === 'error') {
        clearInterval(transcriptPollRef.current!);
        setState(prev => ({ ...prev, phase: 'error', errorMessage: 'Speaker detection failed' }));
      }
    }, 4000);
  }, [user?.id, videoId, videoPublicUrl]);

  /** Submit per-speaker mix job (Phase 2). */
  const applyMix = useCallback(async () => {
    if (!user?.id || !state.enhancement) return;
    const sourceUrl = videoPublicUrl;
    if (!sourceUrl) return;

    setState(prev => ({ ...prev, phase: 'mixing' }));

    const { jobId, error } = await submitMixJob(
      videoId, user.id, sourceUrl,
      state.enhancement.speakerSegments,
      speakerVolumes,
    );

    if (error || !jobId) {
      setState(prev => ({ ...prev, phase: 'error', errorMessage: error ?? 'Mix submission failed' }));
      return;
    }

    // Poll mix job
    mixPollRef.current = setInterval(async () => {
      const result = await pollMixJob(jobId);
      if (result.status === 'completed' && result.outputUrl) {
        clearInterval(mixPollRef.current!);
        setState(prev => ({ ...prev, phase: 'mix-ready', mixOutputUrl: result.outputUrl! }));
      } else if (result.status === 'failed') {
        clearInterval(mixPollRef.current!);
        setState(prev => ({ ...prev, phase: 'error', errorMessage: result.error ?? 'Mix failed' }));
      }
    }, 4000);
  }, [user?.id, videoId, videoPublicUrl, state.enhancement, speakerVolumes]);

  const reset = useCallback(() => {
    stopPolling();
    setState({ phase: 'idle', enhancement: null, mixOutputUrl: null, errorMessage: null });
    setSpeakerVolumes({});
  }, [stopPolling]);

  return {
    state,
    speakerVolumes,
    setSpeakerVolumes,
    analyze,
    applyMix,
    loadCached,
    reset,
  };
}
