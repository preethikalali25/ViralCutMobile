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

// Try multiple RapidAPI endpoint patterns — different subscriptions have different hosts/paths
async function tryDownloadApis(
  url: string,
  apiKey: string,
): Promise<{ videoUrl: string; durationSec: number | null; thumbnail: string | null }> {
  const encoded = encodeURIComponent(url);

  // Only use the subscribed API — unsubscribed fallbacks always 403 and produce misleading errors
  const fetchUrl = `https://facebook-reel-and-video-downloader.p.rapidapi.com/app/main.php?url=${encoded}`;
  const host = 'facebook-reel-and-video-downloader.p.rapidapi.com';

  console.log(`[resolve-reel-url] fetching: ${fetchUrl}`);

  const res = await fetch(fetchUrl, {
    method: 'GET',
    signal: AbortSignal.timeout(25000),
    headers: {
      'X-RapidAPI-Key': apiKey,
      'X-RapidAPI-Host': host,
    },
  });

  console.log(`[resolve-reel-url] status: ${res.status}`);

  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => '');
    console.error(`[resolve-reel-url] auth failure body: ${body.slice(0, 400)}`);
    throw new Error('RapidAPI key invalid or not subscribed. Check RAPIDAPI_KEY in OnSpace secrets.');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[resolve-reel-url] error ${res.status}: ${body.slice(0, 300)}`);
    throw new Error(`RapidAPI returned ${res.status}. Try again or use a different link.`);
  }

  const data = await res.json() as Record<string, unknown>;
  console.log(`[resolve-reel-url] response keys: ${Object.keys(data).join(', ')}, success: ${data.success}`);

  if (data.success === false) {
    const apiErr = String(data.error ?? 'Unknown error');
    console.error(`[resolve-reel-url] api-level error: ${apiErr}`);
    if (apiErr.toLowerCase().includes('private')) {
      throw new Error('This reel is private. Make sure the account and post are public, then try again.');
    }
    throw new Error(`Could not download reel: ${apiErr}`);
  }

  // Extract video URL from response
  const linksObj = data.links as Record<string, string> | undefined;
  const hdUrl = linksObj?.['Download High Quality'] ?? linksObj?.['Download Low Quality'];
  if (hdUrl) {
    return { videoUrl: hdUrl, durationSec: null, thumbnail: (data.thumbnail as string) ?? null };
  }

  const mediaItem = (data.media as { hd_url?: string; sd_url?: string }[] | undefined)?.[0];
  const videoUrl = mediaItem?.hd_url ?? mediaItem?.sd_url;
  if (videoUrl) {
    return { videoUrl, durationSec: null, thumbnail: (data.thumbnail as string) ?? null };
  }

  console.error(`[resolve-reel-url] no video URL found in response: ${JSON.stringify(data).slice(0, 400)}`);
  throw new Error('Could not extract video URL. Make sure the reel is public and try again.');
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
        JSON.stringify({ error: 'Video link resolution not configured. Add RAPIDAPI_KEY to Supabase secrets.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { url } = await req.json() as { url: string };
    const trimmed = url?.trim() ?? '';

    if (!trimmed || !isValidReelUrl(trimmed)) {
      return new Response(
        JSON.stringify({ error: 'Paste a valid Instagram, TikTok, or YouTube Shorts link.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const platform = detectPlatform(trimmed);
    console.log(`[resolve-reel-url] platform=${platform} url=${trimmed}`);

    const result = await tryDownloadApis(trimmed, rapidApiKey);

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
