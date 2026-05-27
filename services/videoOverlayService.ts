import { FFmpegKit, ReturnCode } from 'ffmpeg-kit-react-native';
import * as FileSystem from 'expo-file-system';

export async function burnHookOverlay(
  videoUri: string,
  hookText: string,
): Promise<{ outputUri: string; error?: string }> {
  if (!hookText.trim()) return { outputUri: videoUri };

  const outputUri = `${FileSystem.cacheDirectory}hook_${Date.now()}.mp4`;

  // Escape characters that are special in FFmpeg drawtext filter
  const escaped = hookText
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/%/g, '\\%');

  // White bold text, semi-transparent black box, centred near the bottom
  const drawtext =
    `drawtext=text='${escaped}'` +
    `:fontcolor=white` +
    `:fontsize=54` +
    `:box=1:boxcolor=black@0.55:boxborderw=14` +
    `:x=(w-text_w)/2` +
    `:y=h-th-90` +
    `:shadowcolor=black@0.8:shadowx=2:shadowy=2`;

  const command = `-i "${videoUri}" -vf "${drawtext}" -c:a copy -preset ultrafast -y "${outputUri}"`;

  const session = await FFmpegKit.execute(command);
  const rc = await session.getReturnCode();

  if (ReturnCode.isSuccess(rc)) {
    return { outputUri };
  }

  // Log but fall back to original so publish still works
  const logs = await session.getLogsAsString();
  console.warn('[burnHookOverlay] FFmpeg failed, using original video:', logs.slice(-400));
  return { outputUri: videoUri };
}
