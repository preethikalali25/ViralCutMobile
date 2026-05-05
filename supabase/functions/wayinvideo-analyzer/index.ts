import { corsHeaders } from '../_shared/cors.ts';

const WAYIN_BASE = 'https://wayinvideo-api.wayin.ai/api/v2';
const WAYIN_VERSION = 'v2';

function getEnv(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

function wayinHeaders(apiKey: string) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'x-wayinvideo-api-version': WAYIN_VERSION,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const apiKey = getEnv('WAYINVIDEO_API_KEY');

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* ignore */ }

    const action = (body?.action ?? '') as string;

    // ─── Submit clipping task ─────────────────────────────────────────────────
    if (action === 'submit') {
      const { videoUrl, projectName } = body as { videoUrl: string; projectName?: string };

      if (!videoUrl) {
        return new Response(
          JSON.stringify({ error: 'videoUrl is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      console.log('[wayinvideo] Submitting clip task for URL:', videoUrl.slice(0, 100));

      const res = await fetch(`${WAYIN_BASE}/clips`, {
        method: 'POST',
        headers: wayinHeaders(apiKey),
        body: JSON.stringify({
          video_url: videoUrl,
          project_name: projectName ?? 'ViralCut Analysis',
          target_duration: 'DURATION_0_90',
          limit: 3,
        }),
      });

      const data = await res.json();
      console.log('[wayinvideo] Submit response:', JSON.stringify(data).slice(0, 300));

      if (!res.ok || !data?.data?.id) {
        return new Response(
          JSON.stringify({ error: `WayinVideo: ${JSON.stringify(data)}` }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ taskId: data.data.id, status: data.data.status }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ─── Poll task status + clips ─────────────────────────────────────────────
    if (action === 'status') {
      const { taskId } = body as { taskId: string };

      if (!taskId) {
        return new Response(
          JSON.stringify({ error: 'taskId is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const res = await fetch(`${WAYIN_BASE}/clips/results/${taskId}`, {
        method: 'GET',
        headers: wayinHeaders(apiKey),
      });

      const data = await res.json();
      console.log('[wayinvideo] Status response:', JSON.stringify(data).slice(0, 500));

      if (!res.ok) {
        return new Response(
          JSON.stringify({ error: `WayinVideo status error: ${JSON.stringify(data)}` }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const status = data?.data?.status ?? 'UNKNOWN';
      const clips: Array<{
        title: string;
        description: string;
        hashtags: string[];
        virality_score?: number;
        start?: number;
        end?: number;
      }> = data?.data?.clips ?? [];

      // Normalize clip data
      const normalizedClips = clips.map((c: any) => ({
        title: c.title ?? '',
        description: c.description ?? '',
        hashtags: Array.isArray(c.hashtags) ? c.hashtags : [],
        virality_score: c.virality_score ?? 0,
        start: c.start_timestamp ?? c.start ?? 0,
        end: c.end_timestamp ?? c.end ?? 0,
      }));

      return new Response(
        JSON.stringify({ status, clips: normalizedClips }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}. Use 'submit' or 'status'.` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[wayinvideo-analyzer] Error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
