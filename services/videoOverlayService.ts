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

/**
 * Save a local video to the camera roll so the user can pick it in Instagram,
 * then the caller opens instagram-reels://share to launch the Reels composer.
 */
export async function shareToInstagramReels(
  localUri: string,
  _appId: string,
): Promise<{ error?: string }> {
  try {
    const MediaLibrary = await import('expo-media-library');
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== 'granted') {
      return { error: 'Camera roll access is required to send the video to Instagram. Please allow it in Settings.' };
    }
    await MediaLibrary.saveToLibraryAsync(localUri);
    return {};
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

export async function burnHookOverlay(
  videoUri: string,
  hookText: string,
  backgroundAudioUri?: string,
  originalVolume?: number,
  bgVolume?: number,
): Promise<{ outputUri: string; error?: string }> {
  console.log('[burnHookOverlay] hookText=', JSON.stringify(hookText), 'hasBgAudio=', !!backgroundAudioUri);
  if (!hookText.trim() && !backgroundAudioUri) {
    console.log('[burnHookOverlay] skipping — no text and no bg audio');
    return { outputUri: videoUri };
  }

  if (!VideoTextOverlay?.burnText) {
    console.warn('[burnHookOverlay] Native module not available — hook text will not appear in video');
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
    console.log('[burnHookOverlay] done, outputUri differs from input:', outputUri !== videoUri);
    return { outputUri };
  } catch (e: any) {
    console.warn('[burnHookOverlay] Native overlay failed, using original:', e?.message);
    return { outputUri: videoUri };
  }
}
