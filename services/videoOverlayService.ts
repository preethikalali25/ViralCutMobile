// ffmpeg-kit-react-native removed due to unavailable prebuilt iOS binaries.
// Hook text is shown as UI overlay in the player and prepended to the caption on publish.
export async function burnHookOverlay(
  videoUri: string,
  _hookText: string,
): Promise<{ outputUri: string; error?: string }> {
  return { outputUri: videoUri };
}
