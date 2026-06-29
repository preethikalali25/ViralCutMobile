import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const USER_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name';
const INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const DEEP_LINK = 'shortreel://tiktok-callback';

const env = (k: string) => { const v = Deno.env.get(k); if (!v) throw new Error(`Missing: ${k}`); return v; };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);

  if (req.method === 'GET' && (url.searchParams.get('code') || url.searchParams.get('error'))) {
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const error = url.searchParams.get('error') ?? '';
    const dest = error
      ? `${DEEP_LINK}?error=${encodeURIComponent(error)}`
      : `${DEEP_LINK}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return new Response(null, { status: 302, headers: { Location: dest } });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const action = (url.searchParams.get('action') ?? body?.action ?? '') as string;

  try {
    const clientKey = env('TIKTOK_CLIENT_KEY');
    const clientSecret = env('TIKTOK_CLIENT_SECRET');
    const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    if (action === 'oauth_url') {
      const { redirectUri, codeVerifier } = body as { redirectUri: string; codeVerifier: string };
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const state = crypto.randomUUID();
      const params = new URLSearchParams({ client_key: clientKey, response_type: 'code', scope: 'user.info.basic,video.publish,video.upload,video.list', redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' });
      return json({ authUrl: `${AUTH_URL}?${params}`, state });
    }

    if (action === 'exchange_token') {
      const { code, redirectUri, codeVerifier, userId } = body as { code: string; redirectUri: string; codeVerifier: string; userId: string };
      const tokenRes = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: codeVerifier }) });
      const td = await tokenRes.json();
      if (td.error) return json({ error: `TikTok: ${td.error_description ?? td.error}` }, 400);

      let creatorName = '', creatorAvatar = '';
      try {
        const ur = await fetch(USER_URL, { headers: { Authorization: `Bearer ${td.access_token}` } });
        const ud = await ur.json();
        creatorName = ud?.data?.user?.display_name ?? '';
        creatorAvatar = ud?.data?.user?.avatar_url ?? '';
      } catch { /* ignore */ }

      const { error: dbErr } = await sb.from('tiktok_tokens').upsert({ user_id: userId, open_id: td.open_id, access_token: td.access_token, refresh_token: td.refresh_token ?? null, expires_at: new Date(Date.now() + (td.expires_in ?? 86400) * 1000).toISOString(), refresh_expires_at: td.refresh_expires_in ? new Date(Date.now() + td.refresh_expires_in * 1000).toISOString() : null, scope: td.scope ?? '', creator_name: creatorName, creator_avatar_url: creatorAvatar, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (dbErr) return json({ error: dbErr.message }, 500);
      return json({ success: true, creatorName, creatorAvatar, openId: td.open_id });
    }

    if (action === 'refresh_token') {
      const { userId } = body as { userId: string };
      const { data: row, error: fe } = await sb.from('tiktok_tokens').select('*').eq('user_id', userId).single();
      if (fe || !row?.refresh_token) return json({ error: 'No refresh token — reconnect TikTok.' }, 401);
      const rd = await (await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: row.refresh_token }) })).json();
      if (rd.error) return json({ error: `TikTok: ${rd.error_description ?? rd.error}` }, 400);
      await sb.from('tiktok_tokens').update({ access_token: rd.access_token, refresh_token: rd.refresh_token ?? row.refresh_token, expires_at: new Date(Date.now() + (rd.expires_in ?? 86400) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('user_id', userId);
      return json({ success: true });
    }

    if (action === 'get_status') {
      const { userId } = body as { userId: string };
      const { data: row } = await sb.from('tiktok_tokens').select('open_id,expires_at,creator_name,creator_avatar_url,scope').eq('user_id', userId).maybeSingle();
      if (!row) return json({ connected: false });
      return json({ connected: true, expired: new Date(row.expires_at) < new Date(), creatorName: row.creator_name, creatorAvatar: row.creator_avatar_url, openId: row.open_id });
    }

    if (action === 'disconnect') {
      const { userId } = body as { userId: string };
      await sb.from('tiktok_tokens').delete().eq('user_id', userId);
      return json({ success: true });
    }

    if (action === 'publish') {
      const { userId, title, privacyLevel = 'SELF_ONLY', videoSize, chunkSize, totalChunkCount } = body as { userId: string; videoUrl: string; title: string; privacyLevel?: string; videoSize: number; chunkSize: number; totalChunkCount: number };
      if (!title) return json({ error: 'title is required' }, 400);

      const { data: row, error: te } = await sb.from('tiktok_tokens').select('access_token,refresh_token,expires_at,refresh_expires_at').eq('user_id', userId).single();
      if (te || !row) return json({ error: 'TikTok not connected.' }, 401);

      let accessToken = row.access_token;
      if (new Date(row.expires_at) < new Date()) {
        if (!row.refresh_token || (row.refresh_expires_at && new Date(row.refresh_expires_at) < new Date())) return json({ error: 'TikTok session expired. Please reconnect.' }, 401);
        const rd = await (await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: row.refresh_token }) })).json();
        if (rd.error) return json({ error: 'TikTok session expired. Please reconnect.' }, 401);
        accessToken = rd.access_token;
        await sb.from('tiktok_tokens').update({ access_token: accessToken, refresh_token: rd.refresh_token ?? row.refresh_token, expires_at: new Date(Date.now() + (rd.expires_in ?? 86400) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('user_id', userId);
      }

      const initRes = await fetch(INIT_URL, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ post_info: { title: title.slice(0, 150), privacy_level: privacyLevel, disable_duet: true, disable_comment: true, disable_stitch: true, video_cover_timestamp_ms: 1000 }, source_info: { source: 'FILE_UPLOAD', video_size: videoSize, chunk_size: chunkSize, total_chunk_count: totalChunkCount } }) });
      const id = await initRes.json();
      if (id.error?.code && id.error.code !== 'ok') return json({ error: `TikTok [${id.error.code}]: ${id.error.message}`, tiktokErrorCode: id.error.code }, 502);
      if (!id.data?.publish_id || !id.data?.upload_url) return json({ error: 'TikTok did not return publish_id/upload_url', raw: id }, 502);
      return json({ success: true, publishId: id.data.publish_id, uploadUrl: id.data.upload_url });
    }

    if (action === 'get_analytics') {
      const { userId } = body as { userId: string };
      const { data: row } = await sb.from('tiktok_tokens').select('access_token,expires_at,creator_name,scope').eq('user_id', userId).maybeSingle();
      if (!row) return json({ error: 'TikTok not connected' }, 401);
      if (new Date(row.expires_at) < new Date()) return json({ error: 'TikTok token expired' }, 401);
      if (!(row.scope ?? '').includes('video.list')) return json({ error: 'Reconnect TikTok to enable analytics', needsReconnect: true }, 403);
      const lr = await (await fetch('https://open.tiktokapis.com/v2/video/list/?fields=id,title,cover_image_url,create_time,like_count,comment_count,share_count,view_count', { method: 'POST', headers: { Authorization: `Bearer ${row.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ max_count: 20 }) })).json();
      const videos = ((lr.data?.videos ?? []) as Record<string, unknown>[]).map(v => ({ id: v.id, title: v.title ?? '', thumbnail: v.cover_image_url ?? '', publishedAt: new Date((v.create_time as number) * 1000).toISOString(), views: v.view_count ?? 0, likes: v.like_count ?? 0, shares: v.share_count ?? 0, comments: v.comment_count ?? 0 }));
      return json({ creatorName: row.creator_name, posts: videos.length, totalViews: videos.reduce((s, v) => s + (v.views as number), 0), totalLikes: videos.reduce((s, v) => s + (v.likes as number), 0), totalShares: videos.reduce((s, v) => s + (v.shares as number), 0), videos });
    }

    if (action === 'publish_status') {
      const { userId, publishId } = body as { userId: string; publishId: string };
      const { data: row } = await sb.from('tiktok_tokens').select('access_token').eq('user_id', userId).single();
      if (!row) return json({ error: 'Not connected' }, 401);
      const sr = await (await fetch(STATUS_URL, { method: 'POST', headers: { Authorization: `Bearer ${row.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ publish_id: publishId }) })).json();
      return json({ result: sr });
    }

    return json({ error: `Unknown action: ${action}` }, 400);

  } catch (err) {
    console.error('[tiktok-publisher]', err);
    return json({ error: String(err) }, 500);
  }
});
