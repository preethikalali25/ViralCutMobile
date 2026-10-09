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

  const candidates = [
    // Facebook Reel and Video Downloader (subscribed API)
    // Response: { links: { "Download High Quality": url, "Download Low Quality": url }, media: [{hd_url, sd_url}] }
    {
      fetchUrl: `https://facebook-reel-and-video-downloader.p.rapidapi.com/app/main.php?url=${encoded}`,
      host: 'facebook-reel-and-video-downloader.p.rapidapi.com',
      extract: (d: Record<string, unknown>) => {
        // Try links object first (primary response shape)
        const linksObj = d.links as Record<string, string> | undefined;
        const hdUrl = linksObj?.['Download High Quality'] ?? linksObj?.['Download Low Quality'];
        if (hdUrl) {
          const media = (d.media as { image?: string }[] | undefined)?.[0];
          return { videoUrl: hdUrl, durationSec: null, thumbnail: (d.thumbnail as string) ?? media?.image ?? null };
        }
        // Fallback: media array
        const mediaItem = (d.media as { hd_url?: string; sd_url?: string; image?: string }[] | undefined)?.[0];
        const videoUrl = mediaItem?.hd_url ?? mediaItem?.sd_url;
        return videoUrl ? { videoUrl, durationSec: null, thumbnail: (d.thumbnail as string) ?? mediaItem?.image ?? null } : null;
      },
    },
    // Social Media Video Downloader (fallback)
    {
      fetchUrl: `https://social-media-video-downloader.p.rapidapi.com/smvd/get/all?url=${encoded}`,
      host: 'social-media-video-downloader.p.rapidapi.com',
      extract: (d: Record<string, unknown>) => {
        const links = d.links as { link: string; quality?: string }[] | undefined;
        const video = links?.find((l) => l.link?.includes('.mp4') || l.quality) ?? links?.[0];
        return video?.link ? { videoUrl: video.link, durationSec: (d.duration as number) ?? null, thumbnail: (d.thumbnail as string) ?? null } : null;
      },
    },
    // Instagram Downloader (fallback)
    {
      fetchUrl: `https://instagram-downloader-download-instagram-videos-stories.p.rapidapi.com/index?url=${encoded}`,
      host: 'instagram-downloader-download-instagram-videos-stories.p.rapidapi.com',
      extract: (d: Record<string, unknown>) => {
        const videoUrl = (d.media as string) ?? (d.url as string) ?? (d.video as string);
        return videoUrl ? { videoUrl, durationSec: null, thumbnail: (d.thumbnail as string) ?? null } : null;
      },
    },
  ];

  let anyAuthFailure = false;

  for (const candidate of candidates) {
    try {
      console.log(`[resolve-reel-url] trying ${candidate.host}`);
      const res = await fetch(candidate.fetchUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(25000),
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': candidate.host,
        },
      });

      if (res.status === 404 || res.status === 422) {
        console.warn(`[resolve-reel-url] ${candidate.host} → ${res.status} (wrong endpoint, skipping)`);
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        const body = await res.text().catch(() => '');
        console.warn(`[resolve-reel-url] ${candidate.host} → ${res.status} auth failure. Body: ${body.slice(0, 300)}`);
        anyAuthFailure = true;
        continue; // try next candidate instead of hard-stopping
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`[resolve-reel-url] ${candidate.host} → ${res.status}. Body: ${body.slice(0, 200)}`);
        continue;
      }

      const data = await res.json() as Record<string, unknown>;
      console.log(`[resolve-reel-url] ${candidate.host} response keys: ${Object.keys(data).join(', ')}`);

      const extracted = candidate.extract(data);
      if (extracted?.videoUrl) {
        console.log(`[resolve-reel-url] success via ${candidate.host}`);
        return extracted;
      }
      console.warn(`[resolve-reel-url] ${candidate.host} → extraction returned null`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[resolve-reel-url] ${candidate.host} exception: ${msg}`);
    }
  }

  if (anyAuthFailure) {
    throw new Error('RapidAPI key invalid or subscription required. Check Supabase secrets and your RapidAPI subscription.');
  }

  throw new Error(
    'Could not extract video from this link. Make sure the reel is public and try a different link.',
  );
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
