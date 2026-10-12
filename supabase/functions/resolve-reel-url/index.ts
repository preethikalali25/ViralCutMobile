import { corsHeaders } from '../_shared/cors.ts';

type Platform = 'instagram' | 'tiktok' | 'youtube' | 'unknown';

function detectPlatform(url: string): Platform {
  if (url.includes('instagram.com') || url.includes('instagr.am')) return 'instagram';
  if (url.includes('tiktok.com') || url.includes('vm.tiktok.com')) return 'tiktok';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  return 'unknown';
}

function isValidReelUrl(url: string): boolean {
  if (detectPlatform(url) === 'unknown') return false;
  try { new URL(url); return true; } catch { return false; }
}

async function resolveVideoUrl(
  url: string,
  apiKey: string,
): Promise<{ videoUrl: string; durationSec: number | null; thumbnail: string | null }> {
  const encoded = encodeURIComponent(url);

  // Primary: Instagram Downloader (v5) — /getPost endpoint
  // Response: { video_url, thumbnail_src, src, media: [{video_url, ...}] }
  const igHost = 'instagram-downloader-download-instagram-videos-stories5.p.rapidapi.com';
  const igUrl = `https://${igHost}/getPost?url=${encoded}`;

  console.log(`[resolve-reel-url] fetching ${igUrl}`);

  const res = await fetch(igUrl, {
    method: 'GET',
    signal: AbortSignal.timeout(30000),
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': igHost,
    },
  });

  console.log(`[resolve-reel-url] status: ${res.status}`);

  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => '');
    console.error(`[resolve-reel-url] auth failure: ${body.slice(0, 300)}`);
    throw new Error('RapidAPI key invalid or not subscribed to instagram-downloader-download-instagram-videos-stories5. Check RAPIDAPI_KEY in OnSpace secrets.');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[resolve-reel-url] error ${res.status}: ${body.slice(0, 300)}`);
    throw new Error(`Could not fetch video (status ${res.status}). Try again or use Camera Roll instead.`);
  }

  const data = await res.json() as Record<string, unknown>;
  console.log(`[resolve-reel-url] response keys: ${Object.keys(data).join(', ')}`);

  // Extract video URL — top-level video_url or from media array
  const videoUrl =
    (data.video_url as string | undefined) ??
    ((data.media as { video_url?: string }[] | undefined)?.[0]?.video_url);

  if (!videoUrl) {
    console.error(`[resolve-reel-url] no video_url in response: ${JSON.stringify(data).slice(0, 400)}`);
    throw new Error('Could not extract video URL. Make sure the reel is public and try again.');
  }

  const thumbnail =
    (data.thumbnail_src as string | undefined) ??
    (data.src as string | undefined) ??
    null;

  return { videoUrl, durationSec: null, thumbnail };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const rapidApiKey = Deno.env.get('RAPIDAPI_KEY');
    console.log(`[resolve-reel-url] RAPIDAPI_KEY present=${!!rapidApiKey} length=${rapidApiKey?.length ?? 0}`);
    if (!rapidApiKey) {
      return new Response(
        JSON.stringify({ error: 'Video link resolution not configured. Add RAPIDAPI_KEY to OnSpace secrets.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { url } = await req.json() as { url: string };

    // Strip tracking params — keep only origin+pathname (e.g. instagram.com/reel/ID/)
    let trimmed = url?.trim() ?? '';
    try {
      const u = new URL(trimmed);
      trimmed = `${u.origin}${u.pathname}`;
    } catch { /* leave as-is */ }

    if (!trimmed || !isValidReelUrl(trimmed)) {
      return new Response(
        JSON.stringify({ error: 'Paste a valid Instagram, TikTok, or YouTube Shorts link.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const platform = detectPlatform(trimmed);
    console.log(`[resolve-reel-url] platform=${platform} url=${trimmed}`);

    const result = await resolveVideoUrl(trimmed, rapidApiKey);

    return new Response(
      JSON.stringify({ ...result, platform }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[resolve-reel-url]', msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
