import { getSupabaseClient } from '@/template';
import { FunctionsHttpError } from '@supabase/supabase-js';

export interface WayinClip {
  title: string;
  description: string;
  hashtags: string[];
  virality_score: number;
  start: number;
  end: number;
}

export interface WayinStatusResult {
  status: 'CREATED' | 'QUEUED' | 'ONGOING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  clips: WayinClip[];
  error?: string;
}

async function invoke(action: string, payload: Record<string, unknown>) {
  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke('wayinvideo-analyzer', {
    body: { action, ...payload },
  });
  if (error) {
    let msg = error.message;
    if (error instanceof FunctionsHttpError) {
      try { msg = await error.context?.text() ?? msg; } catch { /* ignore */ }
    }
    return { data: null, error: msg };
  }
  return { data, error: null };
}

/** Upload a public video URL to WayinVideo via their pre-signed upload flow. Returns an identity string. */
export async function uploadToWayin(
  videoUrl: string,
  fileName?: string,
): Promise<{ identity?: string; error?: string }> {
  const { data, error } = await invoke('upload', { videoUrl, fileName });
  if (error) return { error };
  return { identity: data.identity };
}

/** Submit a WayinVideo identity (from uploadToWayin) for AI clip analysis. Returns a taskId. */
export async function submitWayinTask(
  videoIdentity: string,
  projectName?: string,
): Promise<{ taskId?: string; error?: string }> {
  const { data, error } = await invoke('submit', { videoUrl: videoIdentity, projectName });
  if (error) return { error };
  return { taskId: data.taskId };
}

/** Poll for WayinVideo task status and clips. */
export async function getWayinStatus(taskId: string): Promise<WayinStatusResult> {
  const { data, error } = await invoke('status', { taskId });
  if (error) return { status: 'FAILED', clips: [], error };
  return {
    status: data.status,
    clips: data.clips ?? [],
  };
}
