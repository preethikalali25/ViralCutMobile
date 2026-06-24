import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_USER_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name';
const TIKTOK_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const TIKTOK_STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const APP_DEEP_LINK = 'viralcut://tiktok-callback';

function getEnv(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);

  if (req.method === 'GET' && (url.searchParams.get('code') || url.searchParams.get('error'))) {
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const error = url.searchParams.get('error') ?? '';
    if (error) return new Response(null, { status: 302, headers: { Location: `${APP_DEEP_LINK}?error=${encodeURIComponent(error)}` } });
    return new Response(null, { status: 302, headers: { Location: `${APP_DEEP_LINK}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` } });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }

  const action = (url.searchParams.get('action') ?? body?.action ?? '') as string;

  try {
    const clientKey = getEnv('TIKTOK_CLIENT_KEY');
    const clientSecret = getEnv('TIKTOK_CLIENT_SECRET');
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'));

    if (action === 'oauth_url') {
      const { redirectUri, codeVerifier } = body as { redirectUri: string; codeVerifier: string };
      const encoder = new TextEncoder();
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
      const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const state = crypto.randomUUID();
      const params = new URLSearchParams({
        client_key: clientKey, response_type: 'code',
        scope: 'user.info.basic,video.publish,video.upload,video.list',
        redirect_uri: redirectUri, state,
        code_challenge: codeChallenge, code_challenge_method: 'S256',
      });
      return new Response(JSON.stringify({ authUrl: `${TIKTOK_AUTH_URL}?${params}`, state }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'exchange_token') {
      const { code, redirectUri, codeVerifier, userId } = body as { code: string; redirectUri: string; codeVerifier: string; userId: string };

      const tokenRes = await fetch(TIKTOK_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: codeVerifier }),
      });
      const tokenData = await tokenRes.json();

      if (tokenData.error) return new Response(JSON.stringify({ error: `TikTok: ${tokenData.error_description ?? tokenData.error}` }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      const { access_token, refresh_token, expires_in, refresh_expires_in, open_id, scope } = tokenData;

      let creatorName = '', creatorAvatar = '';
      try {
        const userRes = await fetch(TIKTOK_USER_URL, { headers: { Authorization: `Bearer ${access_token}` } });
        const userData = await userRes.json();
        creatorName = userData?.data?.user?.display_name ?? '';
        creatorAvatar = userData?.data?.user?.avatar_url ?? '';
      } catch { /* ignore */ }

      const expiresAt = new Date(Date.now() + (expires_in ?? 86400) * 1000).toISOString();
      const refreshExpiresAt = refresh_expires_in ? new Date(Date.now() + refresh_expires_in * 1000).toISOString() : null;

      const { error: dbError } = await supabase.from('tiktok_tokens').upsert({
        user_id: userId, open_id, access_token, refresh_token: refresh_token ?? null,
        expires_at: expiresAt, refresh_expires_at: refreshExpiresAt, scope: scope ?? '',
        creator_name: creatorName, creator_avatar_url: creatorAvatar, updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

      if (dbError) return new Response(JSON.stringify({ error: `DB error: ${dbError.message}` }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      return new Response(JSON.stringify({ success: true, creatorName, creatorAvatar, openId: open_id }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'refresh_token') {
      const { userId } = body as { userId: string };
      const { data: tokenRow, error: fetchErr } = await supabase.from('tiktok_tokens').select('*').eq('user_id', userId).single();
      if (fetchErr || !tokenRow?.refresh_token) return new Response(JSON.stringify({ error: 'No refresh token stored — please reconnect TikTok.' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      const refreshRes = await fetch(TIKTOK_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: tokenRow.refresh_token }),
      });
      const refreshData = await refreshRes.json();
      if (refreshData.error) return new Response(JSON.stringify({ error: `TikTok refresh: ${refreshData.error_description ?? refreshData.error}` }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      await supabase.from('tiktok_tokens').update({
        access_token: refreshData.access_token,
        refresh_token: refreshData.refresh_token ?? tokenRow.refresh_token,
        expires_at: new Date(Date.now() + (refreshData.expires_in ?? 86400) * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId);

      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'get_status') {
      const { userId } = body as { userId: string };
      const { data: tokenRow } = await supabase.from('tiktok_tokens').select('open_id, expires_at, creator_name, creator_avatar_url, scope').eq('user_id', userId).maybeSingle();
      if (!tokenRow) return new Response(JSON.stringify({ connected: false }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ connected: true, expired: new Date(tokenRow.expires_at) < new Date(), creatorName: tokenRow.creator_name, creatorAvatar: tokenRow.creator_avatar_url, openId: tokenRow.open_id }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'disconnect') {
      const { userId } = body as { userId: string };
      await supabase.from('tiktok_tokens').delete().eq('user_id', userId);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'publish') {
      const { userId, title, privacyLevel = 'SELF_ONLY' } = body as { userId: string; videoUrl: string; title: string; privacyLevel?: string };
      if (!title) return new Response(JSON.stringify({ error: 'title is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      const { data: tokenRow, error: tokenErr } = await supabase.from('tiktok_tokens').select('access_token, refresh_token, expires_at, refresh_expires_at, open_id').eq('user_id', userId).single();
      if (tokenErr || !tokenRow) return new Response(JSON.stringify({ error: 'TikTok not connected. Please connect your TikTok account first.' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      let accessToken = tokenRow.access_token;
      if (new Date(tokenRow.expires_at) < new Date()) {
        const refreshExpired = tokenRow.refresh_expires_at ? new Date(tokenRow.refresh_expires_at) < new Date() : false;
        if (refreshExpired || !tokenRow.refresh_token) return new Response(JSON.stringify({ error: 'TikTok session expired. Please reconnect your TikTok account.' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const refreshRes = await fetch(TIKTOK_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: tokenRow.refresh_token }),
        });
        const refreshData = await refreshRes.json();
        if (refreshData.error) return new Response(JSON.stringify({ error: 'TikTok session expired. Please reconnect your TikTok account.' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        accessToken = refreshData.access_token;
        await supabase.from('tiktok_tokens').update({
          access_token: accessToken, refresh_token: refreshData.refresh_token ?? tokenRow.refresh_token,
          expires_at: new Date(Date.now() + (refreshData.expires_in ?? 86400) * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('user_id', userId);
      }

      const { videoSize, chunkSize, totalChunkCount } = body as { videoSize: number; chunkSize: number; totalChunkCount: number };
      const initPayload = {
        post_info: { title: title.slice(0, 150), privacy_level: privacyLevel, disable_duet: true, disable_comment: true, disable_stitch: true, video_cover_timestamp_ms: 1000 },
        source_info: { source: 'FILE_UPLOAD', video_size: videoSize, chunk_size: chunkSize, total_chunk_count: totalChunkCount },
      };

      const initRes = await fetch(TIKTOK_INIT_URL, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(initPayload) });
      const initData = await initRes.json();

      if (initData.error?.code && initData.error.code !== 'ok') {
        return new Response(JSON.stringify({ error: `TikTok [${initData.error.code}]: ${initData.error.message ?? initData.error.code}`, tiktokErrorCode: initData.error.code, payload: initPayload }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const publishId = initData.data?.publish_id;
      const uploadUrl = initData.data?.upload_url;
      if (!publishId || !uploadUrl) return new Response(JSON.stringify({ error: 'TikTok did not return publish_id/upload_url', raw: initData }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      return new Response(JSON.stringify({ success: true, publishId, uploadUrl }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'get_analytics') {
      const { userId } = body as { userId: string };
      const { data: tokenRow } = await supabase.from('tiktok_tokens').select('access_token, expires_at, creator_name, scope').eq('user_id', userId).maybeSingle();
      if (!tokenRow) return new Response(JSON.stringify({ error: 'TikTok not connected' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      if (new Date(tokenRow.expires_at as string) < new Date()) return new Response(JSON.stringify({ error: 'TikTok token expired' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      if (!(tokenRow.scope as string ?? '').includes('video.list')) return new Response(JSON.stringify({ error: 'Reconnect TikTok to enable analytics', needsReconnect: true }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      try {
        const listRes = await fetch('https://open.tiktokapis.com/v2/video/list/?fields=id,title,cover_image_url,create_time,like_count,comment_count,share_count,view_count', {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokenRow.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ max_count: 20 }),
        });
        const listData = await listRes.json();
        const videos = ((listData.data?.videos ?? []) as Record<string, unknown>[]).map((v) => ({
          id: v.id as string, title: (v.title ?? '') as string, thumbnail: (v.cover_image_url ?? '') as string,
          publishedAt: new Date((v.create_time as number) * 1000).toISOString(),
          views: (v.view_count ?? 0) as number, likes: (v.like_count ?? 0) as number,
          shares: (v.share_count ?? 0) as number, comments: (v.comment_count ?? 0) as number,
        }));
        return new Response(JSON.stringify({
          creatorName: tokenRow.creator_name, posts: videos.length,
          totalViews: videos.reduce((s, v) => s + v.views, 0),
          totalLikes: videos.reduce((s, v) => s + v.likes, 0),
          totalShares: videos.reduce((s, v) => s + v.shares, 0),
          videos,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: `TikTok API error: ${String(e)}` }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    if (action === 'publish_status') {
      const { userId, publishId } = body as { userId: string; publishId: string };
      const { data: tokenRow } = await supabase.from('tiktok_tokens').select('access_token').eq('user_id', userId).single();
      if (!tokenRow) return new Response(JSON.stringify({ error: 'Not connected' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const statusRes = await fetch(TIKTOK_STATUS_URL, { method: 'POST', headers: { Authorization: `Bearer ${tokenRow.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ publish_id: publishId }) });
      const statusData = await statusRes.json();
      return new Response(JSON.stringify({ result: statusData }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
