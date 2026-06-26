/**
 * Scheduler Edge Function
 *
 * Called every minute by pg_cron. Finds pending scheduled posts whose
 * scheduled_at has passed and publishes them to TikTok, Instagram, or YouTube
 * using the stored OAuth tokens — no app or device required.
 */
import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TIKTOK_TOKEN_URL   = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_INIT_URL    = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const IG_GRAPH_URL       = 'https://graph.instagram.com/v21.0';
const IG_LONG_TOKEN_URL  = 'https://graph.instagram.com/access_token';
const GOOGLE_TOKEN_URL   = 'https://oauth2.googleapis.com/token';
const YOUTUBE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const YOUTUBE_VIDEO_URL  = 'https://www.googleapis.com/youtube/v3/videos';

function getEnv(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

interface ScheduledPost {
  id: string;
  user_id: string;
  platform: 'tiktok' | 'reels' | 'youtube';
  video_url: string;
  title: string;
  caption: string;
  hashtags: string;
  hook_text: string;
  privacy_level: string;
  scheduled_at: string;
}

// ── TikTok ────────────────────────────────────────────────────────────────────

async function publishTikTok(
  supabase: ReturnType<typeof createClient>,
  post: ScheduledPost,
  clientKey: string,
  clientSecret: string,
): Promise<{ error?: string }> {
  const { data: row } = await supabase
    .from('tiktok_tokens')
    .select('access_token, refresh_token, expires_at, refresh_expires_at')
    .eq('user_id', post.user_id)
    .maybeSingle();

  if (!row) return { error: 'TikTok not connected' };

  let accessToken = row.access_token as string;

  // Auto-refresh if expired
  if (new Date(row.expires_at as string) < new Date()) {
    if (!row.refresh_token) return { error: 'TikTok token expired — user must reconnect' };
    const refreshRes = await fetch(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: row.refresh_token as string,
      }),
    });
    const refreshData = await refreshRes.json();
    if (refreshData.error) return { error: `TikTok token refresh failed: ${refreshData.error_description}` };
    accessToken = refreshData.access_token;
    await supabase.from('tiktok_tokens').update({
      access_token: accessToken,
      refresh_token: refreshData.refresh_token ?? row.refresh_token,
      expires_at: new Date(Date.now() + (refreshData.expires_in ?? 86400) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('user_id', post.user_id);
  }

  // Fetch video to get its size
  const headRes = await fetch(post.video_url, { method: 'HEAD' });
  const videoSize = parseInt(headRes.headers.get('content-length') ?? '0', 10);
  if (!videoSize) return { error: 'Could not determine video size from storage URL' };

  const title = (post.hook_text || post.title || 'KalELConnect video').slice(0, 150);
  const privacyLevel = post.privacy_level === 'private' ? 'SELF_ONLY' : 'PUBLIC_TO_EVERYONE';

  // Use PULL_FROM_URL — TikTok fetches the video from the public Supabase Storage URL
  const initPayload = {
    post_info: {
      title,
      privacy_level: privacyLevel,
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
    },
    source_info: {
      source: 'PULL_FROM_URL',
      video_url: post.video_url,
    },
  };

  const initRes = await fetch(TIKTOK_INIT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(initPayload),
  });

  const initData = await initRes.json();
  console.log('[scheduler/tiktok] init response:', JSON.stringify(initData).slice(0, 300));

  if (initData.error?.code && initData.error.code !== 'ok') {
    return { error: `TikTok [${initData.error.code}]: ${initData.error.message}` };
  }

  return {};
}

// ── Instagram ─────────────────────────────────────────────────────────────────

async function publishInstagram(
  supabase: ReturnType<typeof createClient>,
  post: ScheduledPost,
  appSecret: string,
): Promise<{ error?: string }> {
  const { data: row } = await supabase
    .from('instagram_tokens')
    .select('access_token, instagram_user_id, expires_at')
    .eq('user_id', post.user_id)
    .maybeSingle();

  if (!row) return { error: 'Instagram not connected' };

  let accessToken = row.access_token as string;

  // Refresh long-lived token if close to expiry (within 7 days)
  const expiresAt = new Date(row.expires_at as string);
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (expiresAt < new Date()) {
    return { error: 'Instagram token expired — user must reconnect' };
  }
  if (expiresAt < sevenDaysFromNow) {
    // Refresh the long-lived token (Instagram allows refreshing within 60 days)
    const refreshParams = new URLSearchParams({
      grant_type: 'ig_refresh_token',
      access_token: accessToken,
    });
    const refreshRes = await fetch(`${IG_LONG_TOKEN_URL}?${refreshParams}`);
    const refreshData = await refreshRes.json();
    if (refreshData.access_token) {
      accessToken = refreshData.access_token;
      const newExpiry = new Date(Date.now() + (refreshData.expires_in ?? 5183944) * 1000).toISOString();
      await supabase.from('instagram_tokens').update({
        access_token: accessToken,
        expires_at: newExpiry,
        updated_at: new Date().toISOString(),
      }).eq('user_id', post.user_id);
    }
  }

  const igUserId = row.instagram_user_id as string;
  const captionParts = [post.hook_text, post.caption, post.hashtags].filter(Boolean);
  const caption = captionParts.join('\n\n').slice(0, 2200);

  // Step 1: Create media container
  const containerParams = {
    media_type: 'REELS',
    video_url: post.video_url,
    caption,
    share_to_feed: 'true',
    access_token: accessToken,
  };

  const containerRes = await fetch(`${IG_GRAPH_URL}/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(containerParams),
  });
  const containerData = await containerRes.json();
  console.log('[scheduler/instagram] container:', JSON.stringify(containerData).slice(0, 200));

  if (containerData.error) {
    return { error: `Instagram container error: ${containerData.error.message}` };
  }
  const containerId = containerData.id;
  if (!containerId) return { error: 'Instagram did not return container ID' };

  // Step 2: Poll until FINISHED (up to 2 minutes)
  let statusCode = '';
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await fetch(
      `${IG_GRAPH_URL}/${containerId}?fields=status_code,status&access_token=${accessToken}`,
    );
    const statusData = await statusRes.json();
    statusCode = statusData.status_code ?? '';
    console.log(`[scheduler/instagram] status poll ${i + 1}: ${statusCode}`);
    if (statusCode === 'FINISHED') break;
    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      return { error: `Instagram processing failed: ${statusCode}` };
    }
  }

  if (statusCode !== 'FINISHED') {
    return { error: 'Instagram video processing timed out' };
  }

  // Step 3: Publish
  const publishRes = await fetch(`${IG_GRAPH_URL}/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: containerId, access_token: accessToken }),
  });
  const publishData = await publishRes.json();
  console.log('[scheduler/instagram] publish:', JSON.stringify(publishData).slice(0, 200));

  if (publishData.error) {
    return { error: `Instagram publish error: ${publishData.error.message}` };
  }

  return {};
}

// ── YouTube ───────────────────────────────────────────────────────────────────

async function publishYouTube(
  supabase: ReturnType<typeof createClient>,
  post: ScheduledPost,
  clientId: string,
): Promise<{ error?: string }> {
  const { data: row } = await supabase
    .from('youtube_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', post.user_id)
    .maybeSingle();

  if (!row) return { error: 'YouTube not connected' };

  let accessToken = row.access_token as string;

  // Auto-refresh if expired
  if (new Date(row.expires_at as string) < new Date(Date.now() + 60_000)) {
    if (!row.refresh_token) return { error: 'No YouTube refresh token — user must reconnect' };
    const refreshBody = new URLSearchParams({
      client_id: clientId,
      refresh_token: row.refresh_token as string,
      grant_type: 'refresh_token',
    });
    const refreshRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      body: refreshBody,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const refreshData = await refreshRes.json();
    if (!refreshData.access_token) return { error: `YouTube token refresh failed: ${refreshData.error}` };
    accessToken = refreshData.access_token;
    await supabase.from('youtube_tokens').update({
      access_token: accessToken,
      expires_at: new Date(Date.now() + (refreshData.expires_in ?? 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('user_id', post.user_id);
  }

  // Fetch video from Supabase Storage
  const videoRes = await fetch(post.video_url);
  if (!videoRes.ok) return { error: `Could not fetch video from storage: ${videoRes.status}` };
  const videoBlob = await videoRes.blob();
  const videoSize = videoBlob.size;

  // Init resumable upload
  const title = (post.hook_text || post.title || 'KalELConnect Short').slice(0, 100);
  const captionParts = [post.caption, post.hashtags].filter(Boolean);
  const description = captionParts.join('\n\n');
  const privacyStatus = post.privacy_level === 'private' ? 'private' : 'public';

  const metadata = {
    snippet: { title, description, categoryId: '22' },
    status: { privacyStatus, selfDeclaredMadeForKids: false },
  };

  const initRes = await fetch(`${YOUTUBE_UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(videoSize),
    },
    body: JSON.stringify(metadata),
  });

  if (!initRes.ok) {
    const errText = await initRes.text();
    return { error: `YouTube init failed (${initRes.status}): ${errText.slice(0, 200)}` };
  }

  const uploadUrl = initRes.headers.get('Location');
  if (!uploadUrl) return { error: 'YouTube did not return upload URL' };

  // Upload video binary
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(videoSize),
    },
    body: videoBlob,
  });

  if (uploadRes.status !== 200 && uploadRes.status !== 201) {
    return { error: `YouTube upload failed: HTTP ${uploadRes.status}` };
  }

  return {};
}

// ── Main Handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl       = getEnv('SUPABASE_URL');
    const serviceRoleKey    = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    const tiktokClientKey   = Deno.env.get('TIKTOK_CLIENT_KEY') ?? '';
    const tiktokClientSecret = Deno.env.get('TIKTOK_CLIENT_SECRET') ?? '';
    const igAppSecret       = Deno.env.get('INSTAGRAM_APP_SECRET') ?? '';
    const youtubeClientId   = Deno.env.get('YOUTUBE_CLIENT_ID') ?? '';

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Find all pending posts that are due
    const { data: duePosts, error: fetchErr } = await supabase
      .from('scheduled_posts')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_at', new Date().toISOString())
      .limit(20);

    if (fetchErr) {
      console.error('[scheduler] fetch error:', fetchErr);
      return new Response(JSON.stringify({ error: fetchErr.message }), { status: 500, headers: corsHeaders });
    }

    if (!duePosts || duePosts.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    console.log(`[scheduler] processing ${duePosts.length} due post(s)`);

    const results = await Promise.allSettled(
      (duePosts as ScheduledPost[]).map(async (post) => {
        // Mark as processing to prevent double-fire
        await supabase.from('scheduled_posts').update({
          status: 'processing',
          updated_at: new Date().toISOString(),
        }).eq('id', post.id).eq('status', 'pending');

        let publishError: string | undefined;

        try {
          if (post.platform === 'tiktok') {
            const res = await publishTikTok(supabase, post, tiktokClientKey, tiktokClientSecret);
            publishError = res.error;
          } else if (post.platform === 'reels') {
            const res = await publishInstagram(supabase, post, igAppSecret);
            publishError = res.error;
          } else if (post.platform === 'youtube') {
            const res = await publishYouTube(supabase, post, youtubeClientId);
            publishError = res.error;
          } else {
            publishError = `Unknown platform: ${post.platform}`;
          }
        } catch (e) {
          publishError = String(e);
        }

        if (publishError) {
          console.error(`[scheduler] post ${post.id} failed:`, publishError);
          await supabase.from('scheduled_posts').update({
            status: 'failed',
            error_message: publishError,
            updated_at: new Date().toISOString(),
          }).eq('id', post.id);
        } else {
          console.log(`[scheduler] post ${post.id} published to ${post.platform}`);
          await supabase.from('scheduled_posts').update({
            status: 'published',
            published_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', post.id);
        }

        return { id: post.id, platform: post.platform, success: !publishError, error: publishError };
      }),
    );

    const summary = results.map(r => r.status === 'fulfilled' ? r.value : { error: String(r.reason) });
    return new Response(
      JSON.stringify({ processed: duePosts.length, results: summary }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[scheduler] unhandled error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
