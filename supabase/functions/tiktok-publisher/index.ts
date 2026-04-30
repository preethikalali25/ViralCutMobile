import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_USER_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name';
const TIKTOK_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const TIKTOK_STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';

function getEnv(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action') ?? (await req.json().then((b: any) => b?.action).catch(() => null));

  try {
    const clientKey = getEnv('TIKTOK_CLIENT_KEY');
    const clientSecret = getEnv('TIKTOK_CLIENT_SECRET');
    const supabaseUrl = getEnv('SUPABASE_URL');
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ─── 1. Generate OAuth URL ────────────────────────────────────────────────
    if (action === 'oauth_url') {
      const body = await req.json();
      const { redirectUri, codeVerifier } = body;

      // PKCE: hash the verifier to get challenge
      const encoder = new TextEncoder();
      const data = encoder.encode(codeVerifier);
      const digest = await crypto.subtle.digest('SHA-256', data);
      const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const state = crypto.randomUUID();
      const params = new URLSearchParams({
        client_key: clientKey,
        response_type: 'code',
        scope: 'user.info.basic,video.publish,video.upload',
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      return new Response(
        JSON.stringify({ authUrl: `${TIKTOK_AUTH_URL}?${params}`, state }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ─── 2. Exchange Code for Tokens ─────────────────────────────────────────
    if (action === 'exchange_token') {
      const body = await req.json();
      const { code, redirectUri, codeVerifier, userId } = body;

      const tokenRes = await fetch(TIKTOK_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: clientKey,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });

      const tokenData = await tokenRes.json();
      console.log('TikTok token response:', JSON.stringify(tokenData).slice(0, 300));

      if (tokenData.error) {
        return new Response(
          JSON.stringify({ error: `TikTok: ${tokenData.error_description ?? tokenData.error}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const { access_token, refresh_token, expires_in, refresh_expires_in, open_id, scope } = tokenData;

      // Fetch creator info
      let creatorName = '';
      let creatorAvatar = '';
      try {
        const userRes = await fetch(TIKTOK_USER_URL, {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        const userData = await userRes.json();
        creatorName = userData?.data?.user?.display_name ?? '';
        creatorAvatar = userData?.data?.user?.avatar_url ?? '';
      } catch (e) {
        console.warn('Could not fetch creator info:', e);
      }

      // Upsert tokens in DB
      const expiresAt = new Date(Date.now() + (expires_in ?? 86400) * 1000).toISOString();
      const refreshExpiresAt = refresh_expires_in
        ? new Date(Date.now() + refresh_expires_in * 1000).toISOString()
        : null;

      const { error: dbError } = await supabase
        .from('tiktok_tokens')
        .upsert({
          user_id: userId,
          open_id,
          access_token,
          refresh_token: refresh_token ?? null,
          expires_at: expiresAt,
          refresh_expires_at: refreshExpiresAt,
          scope: scope ?? '',
          creator_name: creatorName,
          creator_avatar_url: creatorAvatar,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });

      if (dbError) {
        console.error('DB upsert error:', dbError);
        return new Response(
          JSON.stringify({ error: `DB error: ${dbError.message}` }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ success: true, creatorName, creatorAvatar, openId: open_id }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ─── 3. Refresh Token ─────────────────────────────────────────────────────
    if (action === 'refresh_token') {
      const body = await req.json();
      const { userId } = body;

      const { data: tokenRow, error: fetchErr } = await supabase
        .from('tiktok_tokens')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (fetchErr || !tokenRow?.refresh_token) {
        return new Response(
          JSON.stringify({ error: 'No refresh token stored — please reconnect TikTok.' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const refreshRes = await fetch(TIKTOK_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: clientKey,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: tokenRow.refresh_token,
        }),
      });

      const refreshData = await refreshRes.json();
      if (refreshData.error) {
        return new Response(
          JSON.stringify({ error: `TikTok refresh: ${refreshData.error_description ?? refreshData.error}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const expiresAt = new Date(Date.now() + (refreshData.expires_in ?? 86400) * 1000).toISOString();

      await supabase.from('tiktok_tokens').update({
        access_token: refreshData.access_token,
        refresh_token: refreshData.refresh_token ?? tokenRow.refresh_token,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId);

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ─── 4. Get TikTok connection status ──────────────────────────────────────
    if (action === 'get_status') {
      const body = await req.json();
      const { userId } = body;

      const { data: tokenRow } = await supabase
        .from('tiktok_tokens')
        .select('open_id, expires_at, creator_name, creator_avatar_url, scope')
        .eq('user_id', userId)
        .maybeSingle();

      if (!tokenRow) {
        return new Response(
          JSON.stringify({ connected: false }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const isExpired = new Date(tokenRow.expires_at) < new Date();
      return new Response(
        JSON.stringify({
          connected: true,
          expired: isExpired,
          creatorName: tokenRow.creator_name,
          creatorAvatar: tokenRow.creator_avatar_url,
          openId: tokenRow.open_id,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ─── 5. Disconnect TikTok ─────────────────────────────────────────────────
    if (action === 'disconnect') {
      const body = await req.json();
      const { userId } = body;
      await supabase.from('tiktok_tokens').delete().eq('user_id', userId);
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ─── 6. Publish Video to TikTok ───────────────────────────────────────────
    if (action === 'publish') {
      const body = await req.json();
      const { userId, videoUrl, title, privacyLevel = 'SELF_ONLY' } = body;

      if (!videoUrl || !title) {
        return new Response(
          JSON.stringify({ error: 'videoUrl and title are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Fetch stored access token
      const { data: tokenRow, error: tokenErr } = await supabase
        .from('tiktok_tokens')
        .select('access_token, expires_at, open_id')
        .eq('user_id', userId)
        .single();

      if (tokenErr || !tokenRow) {
        return new Response(
          JSON.stringify({ error: 'TikTok not connected. Please connect your TikTok account first.' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Check expiry
      if (new Date(tokenRow.expires_at) < new Date()) {
        return new Response(
          JSON.stringify({ error: 'TikTok token expired. Please reconnect your TikTok account.' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const accessToken = tokenRow.access_token;

      // Step 1 — Initialize upload (FILE_UPLOAD source type for URL-based videos)
      const initPayload: Record<string, unknown> = {
        post_info: {
          title: title.slice(0, 150),
          privacy_level: privacyLevel,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: videoUrl,
        },
      };

      console.log('[tiktok-publisher] Initializing upload:', JSON.stringify(initPayload).slice(0, 300));

      const initRes = await fetch(TIKTOK_INIT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(initPayload),
      });

      const initData = await initRes.json();
      console.log('[tiktok-publisher] Init response:', JSON.stringify(initData).slice(0, 500));

      if (initData.error?.code && initData.error.code !== 'ok') {
        return new Response(
          JSON.stringify({ error: `TikTok: ${initData.error.message ?? initData.error.code}` }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const publishId = initData.data?.publish_id;
      if (!publishId) {
        return new Response(
          JSON.stringify({ error: 'TikTok did not return a publish_id', raw: initData }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ success: true, publishId }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ─── 7. Check publish status ──────────────────────────────────────────────
    if (action === 'publish_status') {
      const body = await req.json();
      const { userId, publishId } = body;

      const { data: tokenRow } = await supabase
        .from('tiktok_tokens')
        .select('access_token')
        .eq('user_id', userId)
        .single();

      if (!tokenRow) {
        return new Response(
          JSON.stringify({ error: 'Not connected' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const statusRes = await fetch(TIKTOK_STATUS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenRow.access_token}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({ publish_id: publishId }),
      });

      const statusData = await statusRes.json();
      console.log('[tiktok-publisher] Status response:', JSON.stringify(statusData).slice(0, 300));

      return new Response(
        JSON.stringify({ result: statusData }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[tiktok-publisher] Error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
