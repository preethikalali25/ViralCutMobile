// Web stub — react-native-video-trim is not supported on web
export async function trim(
  _uri: string,
  _options?: { startTime?: number; endTime?: number }
): Promise<{ outputPath: string }> {
  throw new Error('react-native-video-trim is not supported on web');
}

export async function getFrameAt(
  _uri: string,
  _options?: { time?: number; format?: string; quality?: number; maxWidth?: number }
): Promise<{ outputPath: string }> {
  throw new Error('react-native-video-trim is not supported on web');
}

export function isValidFile(_uri: string): Promise<boolean> {
  return Promise.resolve(false);
}
