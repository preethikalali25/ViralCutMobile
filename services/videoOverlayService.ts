import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';

function escapeFfmpegText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function wrapText(text: string, maxChars = 30): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (test.length > maxChars) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3).join('\n');
}

export async function burnHookOverlay(
  videoUri: string,
  hookText: string,
): Promise<{ outputUri: string; error?: string }> {
  try {
    const { FFmpegKit, ReturnCode } = await import('ffmpeg-kit-react-native');

    const inputPath = videoUri.startsWith('file://') ? videoUri.slice(7) : videoUri;
    const cacheDir = (FileSystem.cacheDirectory ?? 'file:///tmp/').replace('file://', '');
    const outputPath = `${cacheDir}hook_overlay_${Date.now()}.mp4`;

    const wrapped = wrapText(hookText, 30);
    const escaped = escapeFfmpegText(wrapped);

    const fontfileArg = Platform.OS === 'android'
      ? ':fontfile=/system/fonts/Roboto-Regular.ttf'
      : '';

    const filter = [
      `drawtext=text='${escaped}'${fontfileArg}`,
      'fontcolor=white',
      'fontsize=54',
      'x=(w-text_w)/2',
      'y=h*0.07',
      'shadowcolor=black@0.9',
      'shadowx=3',
      'shadowy=3',
      'line_spacing=8',
    ].join(':');

    const cmd = `-i "${inputPath}" -vf "${filter}" -c:v libx264 -preset ultrafast -crf 18 -c:a copy -y "${outputPath}"`;

    const session = await FFmpegKit.execute(cmd);
    const returnCode = await session.getReturnCode();

    if (!ReturnCode.isSuccess(returnCode)) {
      const logs = await session.getLogs();
      const msg = logs
        .slice(-5)
        .map((l: any) => l.getMessage?.() ?? '')
        .join(' ')
        .slice(0, 300);
      console.warn('[burnHookOverlay] failed:', msg);
      return { outputUri: videoUri, error: msg || 'FFmpeg processing failed' };
    }

    return { outputUri: `file://${outputPath}` };
  } catch (e: any) {
    console.warn('[burnHookOverlay] error:', e);
    return { outputUri: videoUri, error: String(e?.message ?? e) };
  }
}
