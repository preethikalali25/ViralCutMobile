/**
 * Module-level cache for pre-extracted video frames.
 * Upload screen populates this so the editor can use frames immediately
 * without waiting for another full video resolution + thumbnail pass.
 */

export interface VideoFrame { base64: string; mime: string }

const cache = new Map<string, VideoFrame[]>();

export function setCachedFrames(videoId: string, frames: VideoFrame[]) {
  cache.set(videoId, frames);
}

export function getCachedFrames(videoId: string): VideoFrame[] | null {
  return cache.get(videoId) ?? null;
}

export function clearCachedFrames(videoId: string) {
  cache.delete(videoId);
}
