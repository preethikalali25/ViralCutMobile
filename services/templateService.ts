import { getSupabaseClient } from '@/template';
import { FunctionsHttpError } from '@supabase/supabase-js';
import type { ReelTemplate, TemplateClip } from '@/types/template';

// ─── Edge function helper ────────────────────────────────────────────────────

async function invokeFunction(
  name: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    if (error instanceof FunctionsHttpError) {
      try {
        const text = await error.context?.text();
        const parsed = text ? JSON.parse(text) : null;
        msg = parsed?.error ?? text ?? msg;
      } catch { /* ignore */ }
    }
    throw new Error(msg ?? `${name} failed`);
  }
  if (data?.error) throw new Error(data.error as string);
  return data as Record<string, unknown>;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function resolveReelUrl(url: string): Promise<{
  videoUrl: string;
  durationSec: number | null;
  platform: string;
  thumbnail: string | null;
}> {
  const data = await invokeFunction('resolve-reel-url', { url });
  if (!data?.videoUrl) throw new Error('No video URL returned from resolver.');
  return {
    videoUrl: data.videoUrl as string,
    durationSec: (data.durationSec as number | null) ?? null,
    platform: (data.platform as string) ?? 'unknown',
    thumbnail: (data.thumbnail as string | null) ?? null,
  };
}

export async function downloadVideoToCache(remoteUrl: string): Promise<{ localUri: string }> {
  const FileSystem = await import('expo-file-system');
  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) throw new Error('No cache directory available.');
  const localUri = `${cacheDir}template_${Date.now()}.mp4`;
  const result = await FileSystem.downloadAsync(remoteUrl, localUri);
  if (result.status !== 200) throw new Error(`Download failed with status ${result.status}.`);
  return { localUri };
}

export async function analyzeReelTemplate(
  localUri: string,
  totalDurationSec: number,
): Promise<ReelTemplate> {
  const frames = await extractKeyFrames(localUri, totalDurationSec);
  if (frames.length === 0) throw new Error('Could not extract frames from video.');

  console.log(`[templateService] sending ${frames.length} frames to analyze-template`);
  const data = await invokeFunction('analyze-template', { frames, totalDurationSec });
  console.log('[templateService] analyze-template response keys:', Object.keys(data ?? {}).join(', '));

  const clips = (data.clips as TemplateClip[] | undefined) ?? [];
  if (clips.length === 0) throw new Error('AI returned no clip segments. Try a different reel.');

  return {
    sourceVideoUri: localUri,
    totalDuration: (data.totalDuration as number) ?? totalDurationSec,
    clipCount: clips.length,
    style: (data.style as ReelTemplate['style']) ?? {
      vibe: 'Custom',
      pacing: 'medium',
      colorGrade: 'vibrant',
      musicGenre: 'pop',
      musicQuery: 'viral trending audio',
    },
    clips,
  };
}

export async function generateSlotImage(prompt: string): Promise<string> {
  const data = await invokeFunction('generate-slot-image', { prompt });
  return data.imageUri as string;
}

// ─── Frame extraction ────────────────────────────────────────────────────────

const MAX_FRAMES = 20;

async function extractKeyFrames(
  videoUri: string,
  totalDurationSec: number,
): Promise<{ timestampSec: number; base64: string }[]> {
  const VideoThumbnails = await import('expo-video-thumbnails');
  const FileSystem = await import('expo-file-system');

  const step = Math.max(0.5, totalDurationSec / MAX_FRAMES);
  const timestamps: number[] = [];
  for (let t = 0; t < totalDurationSec; t += step) {
    timestamps.push(parseFloat(t.toFixed(1)));
    if (timestamps.length >= MAX_FRAMES) break;
  }

  const frames: { timestampSec: number; base64: string }[] = [];
  for (const sec of timestamps) {
    try {
      const { uri: thumbUri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
        time: Math.round(sec * 1000),
        quality: 0.6,
        maxWidth: 512,
      });
      if (!thumbUri) continue;
      const base64 = await FileSystem.readAsStringAsync(thumbUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (base64.length > 100) frames.push({ timestampSec: sec, base64 });
    } catch {
      // skip failed frame
    }
  }
  return frames;
}
