import { getSupabaseClient } from '@/template';
import { FunctionsHttpError } from '@supabase/supabase-js';
import type { ReelTemplate, TemplateClip } from '@/types/template';

async function invokeFunction(name: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      try {
        const body = await error.context.json();
        throw new Error(body?.error ?? error.message);
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message !== error.message) throw parseErr;
      }
    }
    throw new Error(error.message ?? `${name} failed`);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

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

export async function analyzeReelTemplate(
  videoUri: string,
  totalDurationSec: number,
): Promise<ReelTemplate> {
  const frames = await extractKeyFrames(videoUri, totalDurationSec);
  if (frames.length === 0) throw new Error('Could not extract frames from video');

  const data = await invokeFunction('analyze-template', { frames, totalDurationSec });

  return {
    sourceVideoUri: videoUri,
    totalDuration: data.totalDuration ?? totalDurationSec,
    clipCount: data.clipCount ?? data.clips?.length ?? 1,
    style: data.style,
    clips: data.clips as TemplateClip[],
  };
}

export async function resolveReelUrl(url: string): Promise<{
  videoUrl: string;
  platform: string;
  durationSec: number | null;
  thumbnail: string | null;
}> {
  const data = await invokeFunction('resolve-reel-url', { url });
  return data as unknown as { videoUrl: string; platform: string; durationSec: number | null; thumbnail: string | null };
}

export async function downloadVideoToCache(videoUrl: string): Promise<{ localUri: string }> {
  const FileSystem = await import('expo-file-system');
  const dest = FileSystem.cacheDirectory + `reel_template_${Date.now()}.mp4`;
  const result = await FileSystem.downloadAsync(videoUrl, dest);
  if (result.status !== 200) throw new Error('Video download failed');
  return { localUri: result.uri };
}

export async function generateSlotImage(
  prompt: string,
): Promise<string> {
  const data = await invokeFunction('generate-slot-image', { prompt });
  return data.imageUri as string;
}
