import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const IG_AUTH_URL = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const IG_LONG_TOKEN_URL = 'https://graph.instagram.com/access_token';
const IG_GRAPH_URL = 'https://graph.instagram.com/v21.0';

const APP_DEEP_LINK = 'viralcut://instagram-callback';

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

  // ─── OAuth Callback (GET — Instagram/Meta redirects here) ──────────────────
  // Instagram may strip ?action=callback, so also detect by presence of code/error params
  if (req.method === 'GET' && (url.searchParams.get('action') === 'callback' || url.searchParams.has('code') || url.searchParams.has('error'))) {
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const error = url.searchParams.get('error') ?? '';
    const errorReason = url.searchParams.get('error_reason') ?? '';

    if (error) {
      const redirect = `${APP_DEEP_LINK}?error=${encodeURIComponent(error)}&error_reason=${encodeURIComponent(errorReason)}`;
      return new Response(null, { status: 302, headers: { Location: redirect } });
    }

    const redirect = `${APP_DEEP_LINK}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return new Response(null, { status: 302, headers: { Location: redirect } });
  }

  // ─── All other actions as POST JSON ────────────────────────────────────────
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch { /* empty body */ }

  const action = (url.searchParams.get('action') ?? body?.action ?? '') as string;

  try {
    const appId = getEnv('INSTAGRAM_APP_ID');
    const appSecret = getEnv('INSTAGRAM_APP_SECRET');
    const supabaseUrl = getEnv('SUPABASE_URL');
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── 1. Generate OAuth URL ─────────────────────────────────────────────────
    if (action === 'oauth_url') {
      const { redirectUri } = body as { redirectUri: string };
      const state = crypto.randomUUID();

      const params = new URLSearchParams({
        client_id: appId,
        redirect_uri: redirectUri,
        scope: 'instagram_business_basic,instagram_business_content_publish',
        response_type: 'code',
        state,
      });

      return new Response(
        JSON.stringify({ authUrl: `${IG_AUTH_URL}?${params}`, state }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 2. Exchange Code for Long-Lived Token ────────────────────────────────
    if (action === 'exchange_token') {
      const { code, redirectUri, userId } = body as {
        code: string; redirectUri: string; userId: string;
      };

      // Step 1: short-lived token via Instagram Login API
      const shortForm = new FormData();
      shortForm.append('client_id', appId);
      shortForm.append('client_secret', appSecret);
      shortForm.append('grant_type', 'authorization_code');
      shortForm.append('redirect_uri', redirectUri);
      shortForm.append('code', code);

      const shortRes = await fetch(IG_TOKEN_URL, { method: 'POST', body: shortForm });
      const shortData = await shortRes.json();
      console.log('[instagram] short token response:', JSON.stringify(shortData).slice(0, 300));

      if (shortData.error_type || shortData.error) {
        return new Response(
          JSON.stringify({ error: `Instagram: ${shortData.error_message ?? shortData.error_description ?? shortData.error ?? 'OAuth failed'}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const shortToken = shortData.access_token;
      const igUserId = shortData.user_id?.toString() ?? '';

      // Step 2: exchange for long-lived token (60-day)
      const longParams = new URLSearchParams({
        grant_type: 'ig_exchange_token',
        client_secret: appSecret,
        access_token: shortToken,
      });

      const longRes = await fetch(`${IG_LONG_TOKEN_URL}?${longParams}`);
      const longData = await longRes.json();
      console.log('[instagram] long token response:', JSON.stringify(longData).slice(0, 200));

      const accessToken = longData.access_token ?? shortToken;
      const expiresInSec = longData.expires_in ?? 5183944; // ~60 days
      const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

      // Step 3: fetch user profile
      let username = '';
      let profilePictureUrl = '';
      let followersCount = 0;

      try {
        const profileRes = await fetch(
          `${IG_GRAPH_URL}/me?fields=id,username,profile_picture_url,followers_count&access_token=${accessToken}`,
        );
        const profileData = await profileRes.json();
        console.log('[instagram] profile:', JSON.stringify(profileData).slice(0, 200));
        username = profileData.username ?? '';
        profilePictureUrl = profileData.profile_picture_url ?? '';
        followersCount = profileData.followers_count ?? 0;
      } catch (e) {
        console.warn('[instagram] Could not fetch profile:', e);
      }

      // Upsert into DB
      const { error: dbError } = await supabase.from('instagram_tokens').upsert({
        user_id: userId,
        instagram_user_id: igUserId,
        access_token: accessToken,
        expires_at: expiresAt,
        username,
        profile_picture_url: profilePictureUrl,
        followers_count: followersCount,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

      if (dbError) {
        console.error('[instagram] DB error:', dbError);
        return new Response(
          JSON.stringify({ error: `DB error: ${dbError.message}` }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ success: true, username, followersCount, igUserId }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 3. Get Status ────────────────────────────────────────────────────────
    if (action === 'get_status') {
      const { userId } = body as { userId: string };

      const { data: row } = await supabase
        .from('instagram_tokens')
        .select('instagram_user_id, expires_at, username, profile_picture_url, followers_count')
        .eq('user_id', userId)
        .maybeSingle();

      if (!row) {
        return new Response(
          JSON.stringify({ connected: false }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const isExpired = row.expires_at ? new Date(row.expires_at) < new Date() : false;
      return new Response(
        JSON.stringify({
          connected: true,
          expired: isExpired,
          username: row.username,
          profilePictureUrl: row.profile_picture_url,
          followersCount: row.followers_count,
          igUserId: row.instagram_user_id,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 4. Disconnect ────────────────────────────────────────────────────────
    if (action === 'disconnect') {
      const { userId } = body as { userId: string };
      await supabase.from('instagram_tokens').delete().eq('user_id', userId);
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 5. Publish Reel ──────────────────────────────────────────────────────
    // Instagram Reels publishing flow:
    // 1. POST /me/media — create media container (returns container_id)
    // 2. Poll /me/media/{id} until status_code === 'FINISHED'
    // 3. POST /me/media_publish — publish the container
    if (action === 'publish') {
      const { userId, videoUrl, caption = '', coverUrl } = body as {
        userId: string; videoUrl: string; caption?: string; coverUrl?: string;
      };

      if (!videoUrl) {
        return new Response(
          JSON.stringify({ error: 'videoUrl is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Fetch token + IG user ID
      const { data: row, error: tokenErr } = await supabase
        .from('instagram_tokens')
        .select('access_token, expires_at, instagram_user_id')
        .eq('user_id', userId)
        .single();

      if (tokenErr || !row) {
        return new Response(
          JSON.stringify({ error: 'Instagram not connected. Connect your account first.' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return new Response(
          JSON.stringify({ error: 'Instagram token expired. Please reconnect your account.' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const { access_token, instagram_user_id } = row;

      // Step 1: Create media container
      const containerParams: Record<string, string> = {
        media_type: 'REELS',
        video_url: videoUrl,
        caption: caption.slice(0, 2200),
        share_to_feed: 'true',
        access_token,
      };
      if (coverUrl) containerParams.cover_url = coverUrl;

      const containerRes = await fetch(`${IG_GRAPH_URL}/${instagram_user_id}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(containerParams),
      });

      const containerData = await containerRes.json();
      console.log('[instagram] container response:', JSON.stringify(containerData).slice(0, 300));

      if (containerData.error) {
        return new Response(
          JSON.stringify({ error: `Instagram: ${containerData.error.message ?? containerData.error.type ?? 'Upload failed'}` }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const containerId = containerData.id;
      if (!containerId) {
        return new Response(
          JSON.stringify({ error: 'Instagram did not return a container ID', raw: containerData }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ success: true, containerId }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 6. Check container status ────────────────────────────────────────────
    if (action === 'container_status') {
      const { userId, containerId } = body as { userId: string; containerId: string };

      const { data: row } = await supabase
        .from('instagram_tokens')
        .select('access_token')
        .eq('user_id', userId)
        .single();

      if (!row) {
        return new Response(
          JSON.stringify({ error: 'Not connected' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const statusRes = await fetch(
        `${IG_GRAPH_URL}/${containerId}?fields=status_code,status&access_token=${row.access_token}`,
      );
      const statusData = await statusRes.json();
      console.log('[instagram] container status:', JSON.stringify(statusData).slice(0, 200));

      return new Response(
        JSON.stringify({ statusCode: statusData.status_code, status: statusData.status }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 7. Publish container (media_publish) ─────────────────────────────────
    if (action === 'media_publish') {
      const { userId, containerId } = body as { userId: string; containerId: string };

      const { data: row } = await supabase
        .from('instagram_tokens')
        .select('access_token, instagram_user_id')
        .eq('user_id', userId)
        .single();

      if (!row) {
        return new Response(
          JSON.stringify({ error: 'Not connected' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const publishRes = await fetch(`${IG_GRAPH_URL}/${row.instagram_user_id}/media_publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creation_id: containerId, access_token: row.access_token }),
      });

      const publishData = await publishRes.json();
      console.log('[instagram] media_publish response:', JSON.stringify(publishData).slice(0, 200));

      if (publishData.error) {
        return new Response(
          JSON.stringify({ error: `Instagram publish: ${publishData.error.message ?? 'Failed'}` }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ success: true, mediaId: publishData.id }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[instagram-publisher] Error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
