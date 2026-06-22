import { NativeModules } from 'react-native';

const { VideoTextOverlay } = NativeModules;

export type MediaItem = { uri: string; type: 'photo' | 'video' };

export async function combineMediaToVideo(
  items: MediaItem[],
  durationPerPhoto: number = 3.0,
): Promise<string> {
  if (!VideoTextOverlay?.combineMediaToVideo) {
    throw new Error('[combineMediaToVideo] Native module not available');
  }
  return await VideoTextOverlay.combineMediaToVideo(items, durationPerPhoto);
}

export async function photosToVideo(
  photoUris: string[],
  durationPerPhoto: number = 3.0,
): Promise<string> {
  if (!VideoTextOverlay?.photosToVideo) {
    throw new Error('[photosToVideo] Native module not available');
  }
  return await VideoTextOverlay.photosToVideo(photoUris, durationPerPhoto);
}

export async function burnHookOverlay(
  videoUri: string,
  hookText: string,
  backgroundAudioUri?: string,
  originalVolume?: number,
  bgVolume?: number,
): Promise<{ outputUri: string; error?: string }> {
  if (!hookText.trim() && !backgroundAudioUri) return { outputUri: videoUri };

  if (!VideoTextOverlay?.burnText) {
    console.warn('[burnHookOverlay] Native module not available');
    return { outputUri: videoUri };
  }

  try {
    const burnPromise = VideoTextOverlay.burnText(
      videoUri,
      hookText.trim(),
      backgroundAudioUri ?? '',
      originalVolume ?? 0.6,
      bgVolume ?? 0.8,
    ) as Promise<string>;
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('burn timeout after 90s')), 90_000),
    );
    const outputUri = await Promise.race([burnPromise, timeoutPromise]);
    return { outputUri };
  } catch (e: any) {
    console.warn('[burnHookOverlay] Native overlay failed, using original:', e?.message);
    return { outputUri: videoUri };
  }
}
