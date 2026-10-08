import { corsHeaders } from '../_shared/cors.ts';

// Multi-platform video downloader via RapidAPI
// Handles Instagram Reels, TikTok, YouTube Shorts
const RAPIDAPI_HOST = 'social-media-video-downloader.p.rapidapi.com';
const RAPIDAPI_URL = `https://${RAPIDAPI_HOST}/smvd/get/all`;

type Platform = 'instagram' | 'tiktok' | 'youtube' | 'unknown';

function detectPlatform(url: string): Platform {
  if (url.includes('instagram.com') || url.includes('instagr.am')) return 'instagram';
  if (url.includes('tiktok.com') || url.includes('vm.tiktok.com')) return 'tiktok';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  return 'unknown';
}

function isValidReelUrl(url: string): boolean {
  const platform = detectPlatform(url);
  if (platform === 'unknown') return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const rapidApiKey = Deno.env.get('RAPIDAPI_KEY');
    if (!rapidApiKey) {
      return new Response(
        JSON.stringify({ error: 'Video link resolution not configured. Add RAPIDAPI_KEY to Supabase secrets.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { url } = await req.json() as { url: string };

    if (!url?.trim() || !isValidReelUrl(url.trim())) {
      return new Response(
        JSON.stringify({ error: 'Paste a valid Instagram, TikTok, or YouTube Shorts link.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const platform = detectPlatform(url.trim());
    console.log(`[resolve-reel-url] platform=${platform} url=${url.trim()}`);

    const apiRes = await fetch(
      `${RAPIDAPI_URL}?url=${encodeURIComponent(url.trim())}`,
      {
        method: 'GET',
        signal: AbortSignal.timeout(15000),
        headers: {
          'X-RapidAPI-Key': rapidApiKey,
          'X-RapidAPI-Host': RAPIDAPI_HOST,
        },
      },
    );

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      if (apiRes.status === 403) {
        throw new Error('RapidAPI key invalid or subscription required.');
      }
      throw new Error(`Download service error ${apiRes.status}: ${errText}`);
    }

    const result = await apiRes.json() as {
      success?: boolean;
      links?: { link: string; quality?: string }[];
      duration?: number;
      title?: string;
      thumbnail?: string;
    };

    if (!result.success || !result.links?.length) {
      throw new Error('Could not extract video from this link. Make sure the reel is public.');
    }

    // Prefer highest quality video link
    const videoLink = result.links.find((l) =>
      l.link.includes('.mp4') || l.quality === 'hd' || l.quality === 'sd'
    ) ?? result.links[0];

    return new Response(
      JSON.stringify({
        videoUrl: videoLink.link,
        platform,
        durationSec: result.duration ?? null,
        thumbnail: result.thumbnail ?? null,
        title: result.title ?? null,
      }),
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
