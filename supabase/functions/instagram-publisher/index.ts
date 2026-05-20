import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const IG_AUTH_URL = 'https://api.instagram.com/oauth/authorize';
const IG_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const IG_GRAPH_URL = 'https://graph.instagram.com/v21.0';
const FB_GRAPH_URL = 'https://graph.facebook.com/v19.0';
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

  // ── OAuth Callback (GET — Facebook redirects here) ─────────────────────
  if (req.method === 'GET' && url.searchParams.get('action') === 'callback') {
    const code = url.searchParams.get('code') ?? '';
    const error = url.searchParams.get('error') ?? '';
    const errorDesc = url.searchParams.get('error_description') ?? error;
    if (error) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${APP_DEEP_LINK}?error=${encodeURIComponent(errorDesc)}` },
      });
    }
    return new Response(null, {
      status: 302,
      headers: { Location: `${APP_DEEP_LINK}?code=${encodeURIComponent(code)}` },
    });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const action = (url.searchParams.get('action') ?? body?.action ?? '') as string;

  try {
    const appId = getEnv('INSTAGRAM_APP_ID');
    const appSecret = getEnv('INSTAGRAM_APP_SECRET');
    const supabaseUrl = getEnv('SUPABASE_URL');
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── 1. Generate OAuth URL ─────────────────────────────────────────────
    if (action === 'oauth_url') {
      const { redirectUri } = body as { redirectUri: string };
      const params = new URLSearchParams({
        client_id: appId,
        redirect_uri: redirectUri,
        scope: 'instagram_business_basic,instagram_business_content_publish',
        response_type: 'code',
      });
      return new Response(
        JSON.stringify({ authUrl: `${IG_AUTH_URL}?${params}` }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 2. Exchange Code for Tokens ───────────────────────────────────────
    if (action === 'exchange_token') {
      const { code, redirectUri, userId } = body as {
        code: string; redirectUri: string; userId: string;
      };

      // Short-lived token via Instagram Login
      const tokenRes = await fetch(IG_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code }),
      });
      const tokenData = await tokenRes.json();
      if (tokenData.error_type || tokenData.error) {
        return new Response(
          JSON.stringify({ error: `Instagram: ${tokenData.error_message ?? tokenData.error}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      const shortToken = tokenData.access_token;
      const igUserId = String(tokenData.user_id ?? '');

      // Long-lived token (60 days)
      const longRes = await fetch(
        `${IG_GRAPH_URL}/access_token?${new URLSearchParams({
          grant_type: 'ig_exchange_token',
          client_secret: appSecret,
          access_token: shortToken,
        })}`,
      );
      const longData = await longRes.json();
      const accessToken = longData.access_token ?? shortToken;
      const expiresIn = longData.expires_in ?? 5184000;
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

      // Get username
      const profileRes = await fetch(`${IG_GRAPH_URL}/me?fields=username&access_token=${accessToken}`);
      const profileData = await profileRes.json();
      const username = profileData.username ?? 'Instagram User';
      console.log('[instagram-publisher] user:', igUserId, username);

      const { error: dbError } = await supabase.from('instagram_tokens').upsert({
        user_id: userId,
        ig_user_id: igUserId,
        username,
        access_token: pageToken,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

      if (dbError) {
        console.error('[instagram-publisher] DB error:', dbError);
        return new Response(
          JSON.stringify({ error: `DB error: ${dbError.message}` }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ success: true, username, igUserId }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 3. Get Status ─────────────────────────────────────────────────────
    if (action === 'get_status') {
      const { userId } = body as { userId: string };
      const { data } = await supabase
        .from('instagram_tokens')
        .select('ig_user_id, username, expires_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (!data) {
        return new Response(JSON.stringify({ connected: false }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const isExpired = new Date(data.expires_at) < new Date();
      return new Response(
        JSON.stringify({ connected: true, expired: isExpired, username: data.username, igUserId: data.ig_user_id }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 4. Disconnect ─────────────────────────────────────────────────────
    if (action === 'disconnect') {
      const { userId } = body as { userId: string };
      await supabase.from('instagram_tokens').delete().eq('user_id', userId);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── 5. Create Reel Container ──────────────────────────────────────────
    if (action === 'publish') {
      const { userId, videoUrl, caption = '' } = body as {
        userId: string; videoUrl: string; caption?: string;
      };

      const { data: tokenRow } = await supabase
        .from('instagram_tokens')
        .select('access_token, ig_user_id, expires_at')
        .eq('user_id', userId)
        .single();

      if (!tokenRow) {
        return new Response(JSON.stringify({ error: 'Instagram not connected' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (new Date(tokenRow.expires_at) < new Date()) {
        return new Response(JSON.stringify({ error: 'Instagram token expired. Please reconnect.' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const containerRes = await fetch(`${IG_GRAPH_URL}/${tokenRow.ig_user_id}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          media_type: 'REELS',
          video_url: videoUrl,
          caption: caption.slice(0, 2200),
          share_to_feed: true,
          access_token: tokenRow.access_token,
        }),
      });
      const containerData = await containerRes.json();
      console.log('[instagram-publisher] container:', JSON.stringify(containerData).slice(0, 300));

      if (containerData.error) {
        return new Response(
          JSON.stringify({ error: `Instagram: ${containerData.error.message}` }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ success: true, containerId: containerData.id }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 6. Poll Container Status ──────────────────────────────────────────
    if (action === 'publish_status') {
      const { userId, containerId } = body as { userId: string; containerId: string };
      const { data: tokenRow } = await supabase
        .from('instagram_tokens')
        .select('access_token')
        .eq('user_id', userId)
        .single();

      if (!tokenRow) {
        return new Response(JSON.stringify({ error: 'Not connected' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const statusRes = await fetch(
        `${IG_GRAPH_URL}/${containerId}?fields=status_code,status&access_token=${tokenRow.access_token}`,
      );
      const statusData = await statusRes.json();
      console.log('[instagram-publisher] status:', JSON.stringify(statusData).slice(0, 200));

      return new Response(
        JSON.stringify({ statusCode: statusData.status_code, status: statusData.status }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 7. Finalize / Publish ─────────────────────────────────────────────
    if (action === 'publish_finalize') {
      const { userId, containerId } = body as { userId: string; containerId: string };
      const { data: tokenRow } = await supabase
        .from('instagram_tokens')
        .select('access_token, ig_user_id')
        .eq('user_id', userId)
        .single();

      if (!tokenRow) {
        return new Response(JSON.stringify({ error: 'Not connected' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const publishRes = await fetch(`${IG_GRAPH_URL}/${tokenRow.ig_user_id}/media_publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creation_id: containerId,
          access_token: tokenRow.access_token,
        }),
      });
      const publishData = await publishRes.json();
      console.log('[instagram-publisher] finalize:', JSON.stringify(publishData).slice(0, 200));

      if (publishData.error) {
        return new Response(
          JSON.stringify({ error: `Instagram: ${publishData.error.message}` }),
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
