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

    // ─── Upload video to WayinVideo (pre-signed flow) ─────────────────────────
    if (action === 'upload') {
      const { videoUrl, fileName } = body as { videoUrl: string; fileName?: string };

      if (!videoUrl) {
        return new Response(
          JSON.stringify({ error: 'videoUrl is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const name = (fileName ?? videoUrl.split('/').pop()?.split('?')[0] ?? 'video.mp4')
        .replace(/[^a-zA-Z0-9._-]/g, '_');
      const safeName = name.endsWith('.mp4') || name.endsWith('.mov') || name.endsWith('.avi') || name.endsWith('.webm')
        ? name
        : `${name}.mp4`;

      console.log('[wayinvideo] Requesting pre-signed upload URL for:', safeName);

      // Step 1: Get pre-signed upload URL
      const urlRes = await fetch(`${WAYIN_BASE}/upload/single-file`, {
        method: 'POST',
        headers: wayinHeaders(apiKey),
        body: JSON.stringify({ name: safeName }),
      });
      const urlData = await urlRes.json();
      console.log('[wayinvideo] Pre-signed URL response:', JSON.stringify(urlData).slice(0, 300));

      if (!urlRes.ok || !urlData?.data?.upload_url || !urlData?.data?.identity) {
        return new Response(
          JSON.stringify({ error: `WayinVideo upload init failed: ${JSON.stringify(urlData)}` }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const { upload_url, identity } = urlData.data;

      // Step 2: Fetch video from source URL and PUT to pre-signed URL
      console.log('[wayinvideo] Fetching video from storage URL:', videoUrl.slice(0, 100));
      const videoRes = await fetch(videoUrl);
      if (!videoRes.ok) {
        return new Response(
          JSON.stringify({ error: `Failed to fetch video from storage: ${videoRes.status} ${videoRes.statusText}` }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const contentType = videoRes.headers.get('content-type') ?? 'video/mp4';
      console.log('[wayinvideo] Uploading video to WayinVideo pre-signed URL, content-type:', contentType);

      const putRes = await fetch(upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: videoRes.body,
      });

      console.log('[wayinvideo] PUT response status:', putRes.status);

      if (!putRes.ok) {
        const putErr = await putRes.text().catch(() => 'unknown');
        return new Response(
          JSON.stringify({ error: `WayinVideo upload PUT failed: ${putRes.status} ${putErr}` }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ identity }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

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
