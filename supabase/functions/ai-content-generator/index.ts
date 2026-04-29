import { corsHeaders } from '../_shared/cors.ts';

const AI_MODEL = 'google/gemini-3-flash-preview';

/** Build the messages array — if a video frame is supplied, add it as a vision input */
function buildMessages(
  systemPrompt: string,
  userPrompt: string,
  videoFrameBase64?: string,
  videoFrameMime = 'image/jpeg',
) {
  if (videoFrameBase64) {
    return [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${videoFrameMime};base64,${videoFrameBase64}` },
          },
          { type: 'text', text: userPrompt },
        ],
      },
    ];
  }
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get('ONSPACE_AI_API_KEY');
    const baseUrl = Deno.env.get('ONSPACE_AI_BASE_URL');

    if (!apiKey || !baseUrl) {
      return new Response(
        JSON.stringify({ error: 'AI service not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const body = await req.json();
    const {
      type,
      videoTitle,
      hookType,
      platforms,
      /** Optional base64-encoded video frame (JPEG/PNG) for visual analysis */
      videoFrameBase64,
      videoFrameMime = 'image/jpeg',
    } = body;

    const hasFrame = typeof videoFrameBase64 === 'string' && videoFrameBase64.length > 0;

    // Shared context description injected into every prompt when a frame is present
    const visualContext = hasFrame
      ? 'You are given a screenshot/frame captured directly from the video. Use your visual understanding of the scene, subject, action, emotion, and setting to inform your response.'
      : '';

    let systemPrompt = '';
    let userPrompt = '';

    if (type === 'hook') {
      const hookStyleMap: Record<string, string> = {
        question: 'a curiosity-driving question that makes viewers desperate to watch',
        stat: 'a shocking statistic or number that stops the scroll',
        visual: 'a vivid visual description that makes people imagine something surprising',
      };
      const hookStyle = hookStyleMap[hookType] ?? 'a compelling hook';

      systemPrompt = `You are a viral short-form video hook writer for TikTok, Instagram Reels, and YouTube Shorts.
You write punchy, attention-grabbing hooks under 80 characters that stop the scroll instantly.
${visualContext}
Return ONLY the hook text, no quotes, no extra explanation.`;

      userPrompt = hasFrame
        ? `Write ${hookStyle} based on what you see in this video frame.
The video is titled: "${videoTitle}".
Hook type: ${hookType}
Analyse the visual content — the scene, subject, emotion, action — and craft the most viral hook possible.
Keep it under 80 characters.`
        : `Write ${hookStyle} for a video titled: "${videoTitle}".
Hook type: ${hookType}
Keep it under 80 characters. Make it viral, bold, and impossible to scroll past.`;

    } else if (type === 'caption') {
      const platformList = (platforms as string[]).join(', ');

      systemPrompt = `You are a viral content strategist who writes captions and hashtags for short-form video platforms.
You write engaging, platform-optimized captions that boost engagement.
${visualContext}
Return a JSON object with exactly two fields: "caption" (the caption text, 1-3 sentences, engaging and conversational) and "hashtags" (a space-separated string of 5-8 trending hashtags including #fyp or #reels or #youtube as relevant).
Return ONLY valid JSON, no markdown, no code blocks.`;

      userPrompt = hasFrame
        ? `Write an optimized caption and hashtags based on what you see in this video frame.
The video is titled: "${videoTitle}". Target platforms: ${platformList}.
Analyse the visual content — setting, subject, mood, action — and write a caption that feels authentic and drives engagement.`
        : `Write an optimized caption and hashtags for a video titled: "${videoTitle}".
Target platforms: ${platformList}
The caption should feel authentic, drive engagement (comments/shares), and match the platform style.`;

    } else if (type === 'audio') {
      const platformList = (platforms as string[]).join(', ');

      systemPrompt = `You are a music trend analyst for short-form video platforms (TikTok, Instagram Reels, YouTube Shorts).
You are asked to pick the single BEST trending song that maximizes virality for a given video.
${visualContext}
Return a single JSON object: { "id": "ai_best", "title": "Song Title", "artist": "Artist Name", "uses": "estimated uses like 2.4M", "trending": true, "platform": ["tiktok","reels","youtube"], "mood": "one word mood", "reason": "one sentence explaining why this song fits" }.
Return ONLY valid JSON object, no markdown, no code blocks.`;

      userPrompt = hasFrame
        ? `Pick the single BEST trending song for this short-form video based on what you see in the frame.
Video title: "${videoTitle}". Target platforms: ${platformList}.
Consider the visual mood, energy, and subject matter when choosing the song.`
        : `Pick the single BEST trending song for a short-form video titled: "${videoTitle}".
Target platforms: ${platformList}
Choose the song most likely to go viral on these platforms right now.`;

    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid type. Use: hook, caption, or audio' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const messages = buildMessages(systemPrompt, userPrompt, hasFrame ? videoFrameBase64 : undefined, videoFrameMime);

    const aiResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        temperature: 0.85,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error('AI API error:', errText);
      return new Response(
        JSON.stringify({ error: `AI service error: ${errText}` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const aiData = await aiResponse.json();
    const rawContent = aiData.choices?.[0]?.message?.content ?? '';

    if (type === 'hook') {
      return new Response(
        JSON.stringify({ result: rawContent.trim() }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // For caption and audio — parse JSON
    try {
      const cleaned = rawContent.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      return new Response(
        JSON.stringify({ result: parsed }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    } catch {
      console.error('JSON parse failed, raw content:', rawContent);
      return new Response(
        JSON.stringify({ error: 'AI returned invalid format', raw: rawContent }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

  } catch (err) {
    console.error('Edge function error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
