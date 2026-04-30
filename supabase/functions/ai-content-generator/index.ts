import { corsHeaders } from '../_shared/cors.ts';

const AI_MODEL = 'google/gemini-3-flash-preview';

/** Clean up raw filenames into readable titles for the AI */
function sanitizeTitle(raw: string): string {
  return raw
    .replace(/\.[a-zA-Z0-9]{2,5}$/, '')          // strip extension
    .replace(/[_\-]+/g, ' ')                       // underscores/hyphens → spaces
    .replace(/\b\d{4,}\b/g, '')                   // strip long number sequences (timestamps)
    .replace(/\s{2,}/g, ' ')
    .trim()
    || 'my video';
}

/** Shared content safety rules appended to every system prompt */
const SAFETY_RULES = `
IMPORTANT RULES:
- Never produce offensive, hateful, sexually suggestive, violent, discriminatory, or harmful content.
- Write content suitable for all ages and appropriate for mainstream social media platforms.
- Be positive, inclusive, and encouraging.
- If the video title or frame content is unclear or generic, focus on a broadly appealing lifestyle, creativity, or inspiration angle.
`;

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
      videoTitle: rawTitle,
      hookType,
      platforms,
      videoFrameBase64,
      videoFrameMime = 'image/jpeg',
    } = body;

    // Always sanitize the title so the AI never sees raw filenames like "VID_20241201_083012.mp4"
    const videoTitle = sanitizeTitle(rawTitle ?? '');

    const hasFrame = typeof videoFrameBase64 === 'string' && videoFrameBase64.length > 100;
    console.log(`[ai-content-generator] type=${type} hasFrame=${hasFrame} title="${videoTitle}"`);

    const visualContext = hasFrame
      ? 'You are given a screenshot/frame captured directly from the video. Analyse the visual scene — subject, setting, action, emotion, colours, mood — and use this as the PRIMARY source of inspiration.'
      : 'No video frame is available. Base your response on the video title and general short-form video best practices.';

    let systemPrompt = '';
    let userPrompt = '';

    if (type === 'hook') {
      const hookStyleMap: Record<string, string> = {
        question: 'a curiosity-driven question that makes viewers desperate to keep watching',
        stat: 'a surprising fact or number that stops the scroll',
        visual: 'a vivid sensory description that sparks imagination',
      };
      const hookStyle = hookStyleMap[hookType] ?? 'a compelling hook';

      systemPrompt = `You are an expert viral short-form video hook writer for TikTok, Instagram Reels, and YouTube Shorts.
Your hooks are punchy, positive, and under 80 characters.
${visualContext}
${SAFETY_RULES}
Return ONLY the hook text — no quotes, no labels, no explanation.`;

      userPrompt = hasFrame
        ? `Write ${hookStyle} based on what you see in this video frame.
Video title for context: "${videoTitle}". Hook style: ${hookType}.
Describe the visual content — scene, mood, action — and craft the most engaging, brand-safe hook possible.
Under 80 characters. No offensive content.`
        : `Write ${hookStyle} for a short-form video titled: "${videoTitle}".
Hook style: ${hookType}. Keep it under 80 characters.
Make it curious, bold, and scroll-stopping — but always positive and brand-safe.`;

    } else if (type === 'caption') {
      const platformList = (platforms as string[]).join(', ');

      systemPrompt = `You are a viral content strategist writing captions and hashtags for short-form video platforms.
${visualContext}
${SAFETY_RULES}
Return a JSON object with exactly two fields:
- "caption": 1–3 engaging, conversational sentences optimised for the target platforms.
- "hashtags": a space-separated string of 5–8 trending, relevant hashtags (include #fyp, #viral, or platform-specific tags).
Return ONLY valid JSON — no markdown, no code blocks, no extra text.`;

      userPrompt = hasFrame
        ? `Write an optimised caption and hashtags based on what you see in this video frame.
Video title: "${videoTitle}". Target platforms: ${platformList}.
Analyse the visual scene — mood, subject, action — and write authentic, engaging copy that drives comments and shares.`
        : `Write an optimised caption and hashtags for a video titled: "${videoTitle}".
Target platforms: ${platformList}.
Make it authentic, relatable, and engagement-driven. Match the tone to each platform style.`;

    } else if (type === 'audio') {
      const platformList = (platforms as string[]).join(', ');

      systemPrompt = `You are a music trend analyst for short-form video platforms (TikTok, Instagram Reels, YouTube Shorts).
Pick the single BEST currently trending song to maximise virality for the given video.
${visualContext}
${SAFETY_RULES}
Return a single JSON object with these fields:
{ "id": "ai_best", "title": "Song Title", "artist": "Artist Name", "uses": "e.g. 2.4M uses", "trending": true, "platform": ["tiktok","reels","youtube"], "mood": "one word mood", "reason": "one sentence explaining why this song fits the video" }
Return ONLY valid JSON — no markdown, no code blocks, no extra text.`;

      userPrompt = hasFrame
        ? `Pick the single BEST trending song for this short-form video.
Video title: "${videoTitle}". Target platforms: ${platformList}.
Consider the visual mood, energy, subject, and setting shown in the frame when choosing.`
        : `Pick the single BEST trending song for a short-form video titled: "${videoTitle}".
Target platforms: ${platformList}.
Choose a well-known, currently popular song that fits the video's likely mood and maximises viral potential.`;

    } else if (type === 'title') {
      systemPrompt = `You are a social media content strategist who writes compelling, specific video titles for TikTok, Instagram Reels, and YouTube Shorts.
${visualContext}
${SAFETY_RULES}
Return ONLY the title — concise, punchy, 4–10 words, no hashtags, no quotes, no explanation.`;

      userPrompt = hasFrame
        ? `Write a smart, descriptive video title based on what you see in this video frame.
Current filename/title for context: "${videoTitle}".
Describe the actual content — what's happening, who is in it, what is the subject — and turn that into a compelling, specific title that would perform well on short-form platforms. 4–10 words maximum.`
        : `Write a smart, descriptive video title for a short-form video. Current filename: "${videoTitle}".
Ignore any timestamp or technical noise in the filename and craft a compelling, specific title 4–10 words long that would perform well on TikTok/Reels/YouTube Shorts.`;

    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid type. Use: hook, caption, audio, or title' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const messages = buildMessages(
      systemPrompt,
      userPrompt,
      hasFrame ? videoFrameBase64 : undefined,
      videoFrameMime,
    );

    const aiResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        temperature: 0.75,
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
    const rawContent = (aiData.choices?.[0]?.message?.content ?? '').trim();
    console.log(`[ai-content-generator] raw response (first 200 chars): ${rawContent.slice(0, 200)}`);

    if (type === 'hook' || type === 'title') {
      // Strip any accidental quotes the model may wrap around the text
      const text = rawContent.replace(/^["']|["']$/g, '').trim();
      return new Response(
        JSON.stringify({ result: text }),
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
