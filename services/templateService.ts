import { getSupabaseClient } from '@/template';
import { FunctionsHttpError } from '@supabase/supabase-js';
import * as FileSystem from 'expo-file-system';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { ReelTemplate, TemplateSegment } from '@/types';

/** Resolve a public reel link to a direct video URL via the resolve-reel-url edge function. */
export async function resolveReelUrl(url: string): Promise<{
  videoUrl: string;
  durationSec: number | null;
  platform: string;
  thumbnail: string | null;
}> {
  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke('resolve-reel-url', {
    body: { url },
  });
  if (error) {
    let msg = error.message;
    if (error instanceof FunctionsHttpError) {
      try {
        const text = await error.context?.text();
        const parsed = text ? JSON.parse(text) : null;
        msg = parsed?.error ?? text ?? msg;
      } catch { /* ignore */ }
    }
    throw new Error(msg);
  }
  if (!data?.videoUrl) throw new Error('No video URL returned from resolver.');
  return {
    videoUrl: data.videoUrl as string,
    durationSec: (data.durationSec as number | null) ?? null,
    platform: (data.platform as string) ?? 'unknown',
    thumbnail: (data.thumbnail as string | null) ?? null,
  };
}

/** Download a remote video URL to a local cache file. Returns the local file URI. */
export async function downloadVideoToCache(remoteUrl: string): Promise<{ localUri: string }> {
  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) throw new Error('No cache directory available.');

  const filename = `template_${Date.now()}.mp4`;
  const localUri = `${cacheDir}${filename}`;

  const downloadResult = await FileSystem.downloadAsync(remoteUrl, localUri);
  if (downloadResult.status !== 200) {
    throw new Error(`Download failed with status ${downloadResult.status}.`);
  }
  return { localUri };
}

/**
 * Sample frames from a local video and call the AI to extract a ReelTemplate
 * (hook text, caption, suggested cuts, hashtags, etc.).
 * Falls back to a minimal template if AI analysis fails.
 */
export async function analyzeReelTemplate(
  localUri: string,
  durationSec: number,
): Promise<ReelTemplate> {
  // Sample up to 5 frames at 10%, 25%, 50%, 75%, 90% of the video
  const positions = [0.1, 0.25, 0.5, 0.75, 0.9];
  const frames: string[] = [];

  for (const pct of positions) {
    const timeMs = Math.max(500, Math.round(pct * durationSec * 1000));
    try {
      const { uri } = await VideoThumbnails.getThumbnailAsync(localUri, {
        time: timeMs,
        quality: 0.7,
      });
      // Read as base64
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (b64.length > 100) frames.push(b64);
    } catch {
      // skip failed frames
    }
  }

  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke('ai-content-generator', {
    body: {
      action: 'analyze_template',
      frames,
      durationSec,
    },
  });

  if (error) {
    let msg = error.message;
    if (error instanceof FunctionsHttpError) {
      try {
        const text = await error.context?.text();
        const parsed = text ? JSON.parse(text) : null;
        msg = parsed?.error ?? text ?? msg;
      } catch { /* ignore */ }
    }
    // Fall back to a minimal template rather than crashing
    console.warn('[templateService] AI analysis failed, using fallback template:', msg);
    return buildFallbackTemplate(localUri, durationSec);
  }

  if (!data) return buildFallbackTemplate(localUri, durationSec);

  // Normalise the response shape from ai-content-generator
  const template: ReelTemplate = {
    id: `tpl_${Date.now()}`,
    sourceUri: localUri,
    durationSec,
    hook: (data.hook as string) ?? '',
    caption: (data.caption as string) ?? '',
    hashtags: (data.hashtags as string[]) ?? [],
    segments: (data.segments as TemplateSegment[]) ?? buildDefaultSegments(durationSec),
    createdAt: new Date().toISOString(),
  };

  return template;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildFallbackTemplate(sourceUri: string, durationSec: number): ReelTemplate {
  return {
    id: `tpl_${Date.now()}`,
    sourceUri,
    durationSec,
    hook: '',
    caption: '',
    hashtags: [],
    segments: buildDefaultSegments(durationSec),
    createdAt: new Date().toISOString(),
  };
}

function buildDefaultSegments(durationSec: number): TemplateSegment[] {
  // Split into 3 equal segments
  const segDur = durationSec / 3;
  return [
    { startSec: 0, endSec: segDur, label: 'Hook' },
    { startSec: segDur, endSec: segDur * 2, label: 'Body' },
    { startSec: segDur * 2, endSec: durationSec, label: 'CTA' },
  ];
}
