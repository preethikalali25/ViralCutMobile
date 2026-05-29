import { NativeModules } from 'react-native';

const { VideoTextOverlay } = NativeModules;

export async function burnHookOverlay(
  videoUri: string,
  hookText: string,
  backgroundAudioUri?: string,
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
    );
    return { outputUri };
  } catch (e: any) {
    console.warn('[burnHookOverlay] Native overlay failed, using original:', e?.message);
    return { outputUri: videoUri };
  }
}
