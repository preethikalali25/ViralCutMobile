import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const YOUTUBE_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const REDIRECT_URI =
  'com.googleusercontent.apps.384305956807-kv2rnvrc34olbbap2j0k6ilo1i445tpi:/oauth2redirect';

function getEnv(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

async function getValidAccessToken(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  clientId: string,
): Promise<{ accessToken: string } | { error: string }> {
  const { data: row } = await supabase
    .from('youtube_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (!row) return { error: 'YouTube not connected' };

  const needsRefresh = new Date(row.expires_at) < new Date(Date.now() + 60_000);
  if (!needsRefresh) return { accessToken: row.access_token };

  if (!row.refresh_token) return { error: 'No refresh token — user must reconnect YouTube' };

  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: row.refresh_token,
    grant_type: 'refresh_token',
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const data = await res.json();

  if (!data.access_token) {
    return { error: `Token refresh failed: ${data.error_description ?? data.error}` };
  }

  const expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString();
  await supabase
    .from('youtube_tokens')
    .update({ access_token: data.access_token, expires_at: expiresAt, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  return { accessToken: data.access_token };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }

  const url = new URL(req.url);
  const action = (url.searchParams.get('action') ?? body?.action ?? '') as string;

  try {
    const clientId = getEnv('YOUTUBE_CLIENT_ID');
    const supabaseUrl = getEnv('SUPABASE_URL');
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── 0. One-time DB setup — probe multiple SQL endpoints ──────────────
    if (action === 'setup') {
      const base = supabaseUrl.replace(/\/$/, '');
      const sqlEndpoints = [
        `${base}/pg-meta/v1/query`,
        `${base}/api/v1/query`,
        `${base}/admin/v1/query`,
        `${base}/sql`,
      ];

      const createTableSql = `
        CREATE TABLE IF NOT EXISTS public.youtube_tokens (
          user_id           uuid        PRIMARY KEY,
          google_user_id    text        NOT NULL DEFAULT '',
          access_token      text        NOT NULL,
          refresh_token     text        NOT NULL DEFAULT '',
          expires_at        timestamptz NOT NULL,
          channel_id        text        NOT NULL DEFAULT '',
          channel_title     text        NOT NULL DEFAULT '',
          channel_thumbnail text        NOT NULL DEFAULT '',
          updated_at        timestamptz NOT NULL DEFAULT now()
        )
      `;

      const results: Record<string, unknown> = {};
      let succeeded = false;

      for (const endpoint of sqlEndpoints) {
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: createTableSql }),
          });
          const text = await res.text();
          results[endpoint] = { status: res.status, body: text.slice(0, 200) };
          if (res.ok) { succeeded = true; break; }
        } catch (e) {
          results[endpoint] = { error: String(e) };
        }
      }

      return new Response(
        JSON.stringify({ succeeded, results }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 1. Exchange authorization code for tokens ─────────────────────────
    if (action === 'exchange_token') {
      const { code, codeVerifier, userId } = body as {
        code: string; codeVerifier: string; userId: string;
      };

      const tokenBody = new URLSearchParams({
        code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      });

      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        body: tokenBody,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const tokenData = await tokenRes.json();
      console.log('[youtube] token exchange:', JSON.stringify(tokenData).slice(0, 200));

      if (!tokenData.access_token) {
        return new Response(
          JSON.stringify({ error: `Google OAuth failed: ${tokenData.error_description ?? tokenData.error}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const accessToken: string = tokenData.access_token;
      const refreshToken: string = tokenData.refresh_token ?? '';
      const expiresAt = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000).toISOString();

      const userInfoRes = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userInfo = await userInfoRes.json();
      const googleUserId: string = userInfo.sub ?? '';

      const channelRes = await fetch(
        `${YOUTUBE_CHANNELS_URL}?part=snippet&mine=true`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const channelData = await channelRes.json();
      const channel = channelData.items?.[0];
      const channelId: string = channel?.id ?? '';
      const channelTitle: string = channel?.snippet?.title ?? userInfo.name ?? '';
      const channelThumbnail: string = channel?.snippet?.thumbnails?.default?.url ?? userInfo.picture ?? '';

      // Use a SECURITY DEFINER function to bypass PostgREST restrictions
      const { error: rpcError } = await supabase.rpc('upsert_youtube_token', {
        p_user_id: userId,
        p_google_user_id: googleUserId || 'unknown',
        p_access_token: accessToken,
        p_refresh_token: refreshToken || '',
        p_expires_at: expiresAt,
        p_channel_id: channelId || '',
        p_channel_title: channelTitle || '',
        p_channel_thumbnail: channelThumbnail || '',
      });

      if (rpcError) {
        console.error('[youtube] RPC error:', JSON.stringify(rpcError));
        return new Response(
          JSON.stringify({ error: `DB error: ${rpcError.message}` }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ success: true, channelId, channelTitle, channelThumbnail }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 2. Get connection status ──────────────────────────────────────────
    if (action === 'get_status') {
      const { userId } = body as { userId: string };

      const { data: row } = await supabase
        .from('youtube_tokens')
        .select('channel_id, channel_title, channel_thumbnail, expires_at, refresh_token')
        .eq('user_id', userId)
        .maybeSingle();

      if (!row) {
        return new Response(
          JSON.stringify({ connected: false }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const hasRefresh = !!row.refresh_token;
      const isExpired = !hasRefresh && new Date(row.expires_at) < new Date();

      return new Response(
        JSON.stringify({
          connected: true,
          expired: isExpired,
          channelId: row.channel_id,
          channelTitle: row.channel_title,
          channelThumbnail: row.channel_thumbnail,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 3. Initialize YouTube resumable upload → return upload URL ────────
    if (action === 'init_upload') {
      const { userId, title, description, videoSize, privacyStatus } = body as {
        userId: string; title: string; description?: string;
        videoSize: number; privacyStatus?: string;
      };

      const tokenResult = await getValidAccessToken(supabase, userId, clientId);
      if ('error' in tokenResult) {
        return new Response(
          JSON.stringify({ error: tokenResult.error }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const safeTitle = (title || 'ShortReel Short').slice(0, 100);
      const metadata = {
        snippet: {
          title: safeTitle,
          description: description ?? '',
          categoryId: '22',
        },
        status: {
          privacyStatus: privacyStatus ?? 'public',
          selfDeclaredMadeForKids: false,
        },
      };

      const initRes = await fetch(
        `${YOUTUBE_UPLOAD_URL}?uploadType=resumable&part=snippet,status`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenResult.accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': 'video/mp4',
            'X-Upload-Content-Length': String(videoSize),
          },
          body: JSON.stringify(metadata),
        },
      );

      if (!initRes.ok) {
        const errText = await initRes.text();
        console.error('[youtube] init_upload failed:', initRes.status, errText);
        return new Response(
          JSON.stringify({ error: `YouTube init failed (${initRes.status}): ${errText.slice(0, 300)}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const uploadUrl = initRes.headers.get('Location');
      if (!uploadUrl) {
        return new Response(
          JSON.stringify({ error: 'YouTube did not return an upload URL' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ uploadUrl }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 4. Get Analytics ─────────────────────────────────────────────────
    if (action === 'get_analytics') {
      const { userId } = body as { userId: string };

      const tokenResult = await getValidAccessToken(supabase, userId, clientId);
      if ('error' in tokenResult) {
        return new Response(JSON.stringify({ error: tokenResult.error }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const { accessToken } = tokenResult;

      // Fetch channel stats + recent uploads
      const [channelRes, searchRes] = await Promise.all([
        fetch(`${YOUTUBE_CHANNELS_URL}?part=snippet,statistics&mine=true`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10000),
        }),
        fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&forMine=true&type=video&maxResults=50&order=date`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10000),
        }),
      ]);

      const channelData = await channelRes.json();
      const searchData = await searchRes.json();

      if (channelData.error) {
        return new Response(JSON.stringify({ error: `YouTube API: ${channelData.error.message}` }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const channel = channelData.items?.[0];
      const stats = channel?.statistics ?? {};
      const subscribers = parseInt(stats.subscriberCount ?? '0', 10);
      const totalViews = parseInt(stats.viewCount ?? '0', 10);

      // Fetch video stats for the returned videos
      const videoIds: string[] = ((searchData.items ?? []) as Record<string, unknown>[])
        .map(i => ((i.id as Record<string, unknown>)?.videoId as string))
        .filter(Boolean);

      let videos: Record<string, unknown>[] = [];
      if (videoIds.length > 0) {
        const statsRes = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoIds.join(',')}&maxResults=50`,
          { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) },
        );
        const statsData = await statsRes.json();
        videos = ((statsData.items ?? []) as Record<string, unknown>[]).map(v => {
          const s = (v as any).statistics ?? {};
          const sn = (v as any).snippet ?? {};
          return {
            id: v.id as string,
            title: sn.title ?? '',
            thumbnail: sn.thumbnails?.medium?.url ?? sn.thumbnails?.default?.url ?? '',
            publishedAt: sn.publishedAt ?? '',
            views: parseInt(s.viewCount ?? '0', 10),
            likes: parseInt(s.likeCount ?? '0', 10),
            shares: 0,
            comments: parseInt(s.commentCount ?? '0', 10),
          };
        });
      }

      return new Response(JSON.stringify({
        channelTitle: channel?.snippet?.title ?? '',
        subscribers,
        totalViews,
        videoCount: videos.length,
        videos,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── 5. Disconnect ─────────────────────────────────────────────────────
    if (action === 'disconnect') {
      const { userId } = body as { userId: string };
      await supabase.from('youtube_tokens').delete().eq('user_id', userId);
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[youtube-publisher] unhandled error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
