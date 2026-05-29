import { NativeModules } from 'react-native';

const { VideoTextOverlay } = NativeModules;

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
    const outputUri: string = await VideoTextOverlay.burnText(
      videoUri,
      hookText.trim(),
      backgroundAudioUri ?? '',
      originalVolume ?? 0.6,
      bgVolume ?? 0.8,
    );
    return { outputUri };
  } catch (e: any) {
    console.warn('[burnHookOverlay] Native overlay failed, using original:', e?.message);
    return { outputUri: videoUri };
  }
}
