// Web stub — expo-video-thumbnails is not supported on web
export async function getThumbnailAsync(
  _uri: string,
  _options?: { time?: number; quality?: number }
): Promise<{ uri: string; width: number; height: number }> {
  throw new Error('expo-video-thumbnails is not supported on web');
}
