import { getSupabaseClient } from '@/template';
import type { ReelTemplate, TemplateClip } from '@/types/template';

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

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.functions.invoke('analyze-template', {
    body: { frames, totalDurationSec },
  });

  if (error) throw new Error(error.message ?? 'Template analysis failed');
  if (data.error) throw new Error(data.error);

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
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.functions.invoke('resolve-reel-url', {
    body: { url },
  });
  if (error) throw new Error(error.message ?? 'Could not resolve link');
  if (data.error) throw new Error(data.error);
  return data as { videoUrl: string; platform: string; durationSec: number | null; thumbnail: string | null };
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
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.functions.invoke('generate-slot-image', {
    body: { prompt },
  });
  if (error) throw new Error(error.message ?? 'Image generation failed');
  if (data.error) throw new Error(data.error);
  return data.imageUri as string;
}
