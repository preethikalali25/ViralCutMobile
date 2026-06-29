import { getSupabaseClient } from '@/template';

export interface SpeakerSegment {
  speaker: string;
  start: number; // ms
  end: number;   // ms
  text: string;
}

export interface VoiceEnhancement {
  id: string;
  speakerCount: number;
  speakerSegments: SpeakerSegment[];
  enhancedUrl: string | null;
  status: 'pending' | 'analyzing' | 'ready' | 'failed';
  errorMessage?: string;
}

async function invoke(fn: string, body: Record<string, unknown>) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) return { data: null, error: error.message };
  if (data?.error) return { data: null, error: data.error };
  return { data, error: null };
}

/** Start speaker diarization for a video (AssemblyAI). */
export async function submitVoiceAnalysis(
  videoId: string,
  userId: string,
  videoUrl: string,
): Promise<{ enhancementId?: string; transcriptId?: string; error?: string }> {
  const { data, error } = await invoke('voice-analyzer', {
    action: 'submit', videoId, userId, videoUrl,
  });
  if (error) return { error };
  return {
    enhancementId: data.enhancementId,
    transcriptId: data.transcriptId,
  };
}

/** Poll AssemblyAI transcript status. */
export async function pollTranscript(transcriptId: string, enhancementId: string) {
  return invoke('voice-analyzer', { action: 'poll-transcript', transcriptId, enhancementId });
}

/** Get cached voice enhancement from DB. */
export async function getCachedEnhancement(
  videoId: string,
  userId: string,
): Promise<{ enhancement: VoiceEnhancement | null; error?: string }> {
  const { data, error } = await invoke('voice-analyzer', { action: 'get', videoId, userId });
  if (error) return { enhancement: null }; // fail silently — function may not be deployed yet
  const raw = data?.enhancement;
  if (!raw) return { enhancement: null };
  return {
    enhancement: {
      id: raw.id,
      speakerCount: raw.speaker_count ?? 0,
      speakerSegments: raw.speaker_segments ?? [],
      enhancedUrl: raw.enhanced_url ?? null,
      status: raw.status,
      errorMessage: raw.error_message,
    },
  };
}

/** Submit a speaker volume mix job. */
export async function submitMixJob(
  videoId: string,
  userId: string,
  inputUrl: string,
  speakerSegments: SpeakerSegment[],
  speakerVolumes: Record<string, number>,
): Promise<{ jobId?: string; error?: string }> {
  const { data, error } = await invoke('voice-mixer', {
    action: 'submit', videoId, userId, inputUrl, speakerSegments, speakerVolumes,
  });
  if (error) return { error };
  return { jobId: data.jobId };
}

/** Poll mix job status. */
export async function pollMixJob(
  jobId: string,
): Promise<{ status: string; outputUrl?: string; error?: string }> {
  const { data, error } = await invoke('voice-mixer', { action: 'status', jobId });
  if (error) return { status: 'error', error };
  return { status: data.status, outputUrl: data.outputUrl ?? undefined, error: data.error };
}

/** Compute speaking-time percentage per speaker. */
export function computeSpeakerStats(
  segments: SpeakerSegment[],
): Record<string, { durationMs: number; percent: number }> {
  const totals: Record<string, number> = {};
  for (const seg of segments) {
    totals[seg.speaker] = (totals[seg.speaker] ?? 0) + (seg.end - seg.start);
  }
  const grand = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  const result: Record<string, { durationMs: number; percent: number }> = {};
  for (const [speaker, ms] of Object.entries(totals)) {
    result[speaker] = { durationMs: ms, percent: Math.round((ms / grand) * 100) };
  }
  return result;
}
