import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const IG_GRAPH_URL = 'https://graph.instagram.com/v21.0';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const { userId, galleryThumbnails = [] } = body as {
      userId: string;
      galleryThumbnails: Array<{ id: string; type: 'photo' | 'video'; base64: string }>;
    };

    if (!userId) {
      return new Response(JSON.stringify({ error: 'userId required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Fetch Instagram token from DB ──────────────────────────────────────────
    const { data: tokenRow, error: tokenErr } = await supabase
      .from('instagram_tokens')
      .select('access_token, ig_user_id')
      .eq('user_id', userId)
      .single();

    if (tokenErr || !tokenRow) {
      return new Response(JSON.stringify({ error: 'Instagram not connected' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { access_token, ig_user_id } = tokenRow as { access_token: string; ig_user_id: string };

    // ── Fetch Instagram profile ────────────────────────────────────────────────
    const igSignal = AbortSignal.timeout(12000);
    let profile: Record<string, unknown> = {};
    let recentPosts: unknown[] = [];

    try {
      const [profileRes, mediaRes] = await Promise.all([
        fetch(`${IG_GRAPH_URL}/${ig_user_id}?fields=username,biography,followers_count,media_count&access_token=${access_token}`, { signal: igSignal }),
        fetch(`${IG_GRAPH_URL}/${ig_user_id}/media?fields=id,media_type,timestamp,caption,like_count,comments_count&limit=12&access_token=${access_token}`, { signal: igSignal }),
      ]);

      profile = await profileRes.json();
      const mediaData = await mediaRes.json();

      recentPosts = ((mediaData.data ?? []) as any[]).map((p) => ({
        type: p.media_type as string,
        caption: (p.caption as string | undefined)?.slice(0, 120),
        likes: p.like_count as number | undefined,
        comments: p.comments_count as number | undefined,
        date: (p.timestamp as string).split('T')[0],
      }));
    } catch (igErr) {
      console.warn('[content-advisor] Instagram API error:', igErr);
      // Continue with empty profile — AI will work from gallery alone
    }

    // ── Build AI prompt ────────────────────────────────────────────────────────
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'AI service not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const profileSummary = `Instagram Profile:
Username: @${profile.username ?? 'unknown'}
Bio: ${profile.biography || 'Not set'}
Followers: ${profile.followers_count?.toLocaleString() ?? 'unknown'}
Total posts: ${profile.media_count ?? 'unknown'}

Last ${recentPosts.length} posts:
${recentPosts.map((p, i) =>
  `${i + 1}. [${p.type}] ${p.date} | ${p.likes ?? '?'} likes | ${p.comments ?? '?'} comments | "${p.caption ?? 'no caption'}"`
).join('\n')}`;

    const thumbCount = Math.min(galleryThumbnails.length, 8);
    const photoCount = galleryThumbnails.filter((g) => g.type === 'photo').length;
    const videoCount = galleryThumbnails.filter((g) => g.type === 'video').length;

    const systemPrompt = `You are a viral short-form video content strategist.
You will analyse an Instagram creator's profile and their media gallery, then suggest exactly 3 Reel ideas they should make RIGHT NOW.

CRITICAL RULES:
- Suggestions must be specific to THIS creator's niche and audience — no generic advice.
- Reference gallery items by their index (0-based) in galleryIndices.
- Each hook must be under 80 characters.
- Explain why each idea fits THIS account's engagement patterns.
- If the profile shows kids/family content, suggest family reels. If fitness, suggest fitness. Match the niche.

Return ONLY a valid JSON array of exactly 3 objects — no markdown, no code blocks, no extra text:
[
  {
    "id": "s1",
    "title": "Short reel title (5-8 words)",
    "hook": "Hook text under 80 chars",
    "reason": "One sentence: why this will perform well for this specific account",
    "galleryIndices": [0, 1, 2],
    "contentType": "photo_montage|video_clip|mixed"
  }
]`;

    // Build multimodal content
    const userContent: any[] = [];

    // Add up to 8 gallery thumbnails as images
    for (let i = 0; i < thumbCount; i++) {
      const item = galleryThumbnails[i];
      if (item.base64 && item.base64.length > 100) {
        userContent.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: item.base64 },
        });
      }
    }

    userContent.push({
      type: 'text',
      text: `${profileSummary}

Gallery: ${galleryThumbnails.length} recent items (${photoCount} photos, ${videoCount} videos).
${thumbCount > 0 ? `I've shown you thumbnails for items 0–${thumbCount - 1} above.` : ''}

Suggest 3 Reel ideas using these specific gallery items. Return JSON only.`,
    });

    const aiRes = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(28000),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
        temperature: 0.7,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return new Response(JSON.stringify({ error: `AI error: ${errText}` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const aiData = await aiRes.json();
    const rawText = ((aiData.content?.[0]?.text as string) ?? '').trim();

    let suggestions: unknown[];
    try {
      const cleaned = rawText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      suggestions = JSON.parse(cleaned);
    } catch {
      return new Response(JSON.stringify({ error: 'AI returned invalid format', raw: rawText }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(
      JSON.stringify({
        profile: {
          username: profile.username,
          followers: profile.followers_count,
          bio: profile.biography,
          recentPosts,
        },
        suggestions,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[content-advisor]', err);
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
