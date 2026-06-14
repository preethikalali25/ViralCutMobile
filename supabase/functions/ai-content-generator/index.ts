import { corsHeaders } from '../_shared/cors.ts';

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_MODEL_SONNET = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

function sanitizeTitle(raw: string): string {
  return raw
    .replace(/\.[a-zA-Z0-9]{2,5}$/, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\b\d{4,}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const SAFETY_RULES = `
IMPORTANT RULES:
- Never produce offensive, hateful, sexually suggestive, violent, discriminatory, or harmful content.
- Write content suitable for all ages and appropriate for mainstream social media platforms.
- Be positive, inclusive, and encouraging.
- If the video title or frame content is unclear or generic, focus on a broadly appealing lifestyle, creativity, or inspiration angle.
`;

const GENERIC_HOOK_BAN = `
BANNED PHRASES — never use these or anything like them:
"You won't believe", "Wait until you see", "I can't stop watching", "This is amazing", "Check this out",
"Wait for it", "Mind blown", "Game changer", "The best thing ever", "You need to see this",
"I had no idea", "This changed my life", "POV: you discovered", "Nobody talks about this",
any phrase that could apply to ANY video and gives the viewer no specific reason to watch.
Every word of the hook must be SPECIFIC to this exact video's content.
`;

function buildUserContent(
  userPrompt: string,
  frames: Array<{ base64: string; mime: string }>,
) {
  if (frames.length === 0) return userPrompt;
  return [
    ...frames.map(f => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: f.mime,
        data: f.base64,
      },
    })),
    { type: 'text', text: userPrompt },
  ];
}

async function callAnthropic(
  model: string,
  system: string,
  userContent: unknown,
  maxTokens = 512,
  temperature = 0.85,
): Promise<string> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')!;
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(28000),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }],
      temperature,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error: ${err}`);
  }
  const data = await res.json();
  return (data.content?.[0]?.text ?? '').trim();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
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
      videoFrames,
      videoFrameBase64,
      videoFrameMime = 'image/jpeg',
      creatorCaptions,
      userContext = '',
    } = body;

    const videoTitle = sanitizeTitle(rawTitle ?? '');

    const rawFrames: Array<{ base64: string; mime: string }> = (() => {
      if (Array.isArray(videoFrames) && videoFrames.length > 0) {
        return (videoFrames as Array<{ base64: string; mime: string }>)
          .filter(f => typeof f.base64 === 'string' && f.base64.length > 100 && f.base64.length < 200_000)
          .slice(0, 5);
      }
      if (typeof videoFrameBase64 === 'string' && videoFrameBase64.length > 100 && videoFrameBase64.length < 200_000) {
        return [{ base64: videoFrameBase64, mime: videoFrameMime ?? 'image/jpeg' }];
      }
      return [];
    })();

    const hasFrame = rawFrames.length > 0;
    console.log(`[ai-content-generator] type=${type} hasFrame=${hasFrame} frames=${rawFrames.length} title="${videoTitle}"`);

    const visualContext = hasFrame
      ? rawFrames.length > 1
        ? `You are given ${rawFrames.length} frames captured at different points in the video (beginning, quarter, middle, three-quarters, near end). Analyse ALL frames — who is in the video, what they are doing, the exact setting, actions, emotions, objects, colours, and mood across the timeline — and use this as the PRIMARY source of truth about the video content.`
        : 'You are given a screenshot/frame captured directly from the video. Analyse the visual scene — who is present, what they are doing, exact setting, action, emotion, colours, mood — and use this as the PRIMARY source of truth.'
      : videoTitle
      ? 'No video frame is available. Base your response on the video title and general short-form video best practices.'
      : 'No video frame or title is available. Write based on general short-form video best practices for lifestyle, creativity, and everyday moments.';

    const contextNote = userContext
      ? `\nCREATOR CONTEXT: "${userContext}" — this is the creator's own description of what the video is about. Treat it as ground truth.`
      : '';

    let systemPrompt = '';
    let userPrompt = '';

    if (type === 'hook') {
      const hookStyleMap: Record<string, string> = {
        question: 'a curiosity-driven question that names the SPECIFIC subject and makes viewers desperate to keep watching',
        stat: 'a surprising specific fact or number directly related to what is shown in the video',
        visual: 'a vivid sensory description of the exact scene that sparks immediate imagination',
      };

      const captionsBlock = Array.isArray(creatorCaptions) && creatorCaptions.length > 0
        ? `\nCREATOR'S INSTAGRAM CAPTIONS — study these to match their exact writing voice, tone, emoji usage, and phrasing style:\n${(creatorCaptions as string[]).map((c, i) => `${i + 1}. "${c}"`).join('\n')}\nWrite EACH hook IN THIS EXACT VOICE — it must sound like this creator wrote it, not a generic template.`
        : '';

      const sharedSystem = `You are an expert viral short-form video hook writer for TikTok, Instagram Reels, and YouTube Shorts.
Your hooks are hyper-specific, punchy, and under 80 characters.
${visualContext}
${captionsBlock}
${SAFETY_RULES}
${GENERIC_HOOK_BAN}`;

      // Build one prompt per style and run all 3 in parallel
      const styles = ['question', 'stat', 'visual'] as const;

      const hookPromises = styles.map(style => {
        const hookStyle = hookStyleMap[style];
        const uPrompt = hasFrame
          ? `Look at ${rawFrames.length > 1 ? 'these video frames' : 'this video frame'} carefully.
Identify with precision: WHO is in the video (their age/type if visible), WHAT exact action they are doing, WHERE this is happening, and any notable emotion or detail.
Now write ${hookStyle} based on what you ACTUALLY SEE.
Name the specific subject — do NOT say "this", "it", or vague words. Use the creator's own words if captions are provided.
Video title for extra context: "${videoTitle || 'unknown'}".${contextNote}
Style: ${style}. Under 80 characters. Return ONLY the hook text — no quotes, no labels.`
          : videoTitle
          ? `Write ${hookStyle} for a short-form video titled: "${videoTitle}".${contextNote}
Style: ${style}. Under 80 characters.
Be specific to the title's subject. No generic filler. Return ONLY the hook text.`
          : `Write ${hookStyle} for a short-form video.${contextNote || ' No title or frame available.'}
Style: ${style}. Under 80 characters.
Return ONLY the hook text.`;

        const uContent = buildUserContent(uPrompt, rawFrames);
        return callAnthropic(ANTHROPIC_MODEL_SONNET, sharedSystem, uContent, 150, 0.9)
          .then(text => text.replace(/^["']|["']$/g, '').trim())
          .catch(() => '');
      });

      const variations = await Promise.all(hookPromises);
      const validVariations = variations.filter(v => v.length > 5);

      return new Response(
        JSON.stringify({ result: validVariations }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );

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
        ? `Write an optimised caption and hashtags based on what you see in ${rawFrames.length > 1 ? 'these video frames' : 'this video frame'}.
Video title: "${videoTitle || 'unknown'}". Target platforms: ${platformList}.${contextNote}
Analyse the visual scene — mood, subject, action — and write authentic, engaging copy that drives comments and shares.`
        : videoTitle
        ? `Write an optimised caption and hashtags for a video titled: "${videoTitle}".${contextNote}
Target platforms: ${platformList}.
Make it authentic, relatable, and engagement-driven. Match the tone to each platform style.`
        : `Write an optimised caption and hashtags for a short-form video.${contextNote || ' No title is available.'}
Target platforms: ${platformList}.
Use a broadly appealing lifestyle or everyday moment angle. Make it authentic, relatable, and engagement-driven.`;

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
Video title: "${videoTitle || 'unknown'}". Target platforms: ${platformList}.${contextNote}
Consider the visual mood, energy, subject, and setting shown in ${rawFrames.length > 1 ? 'the frames' : 'the frame'} when choosing.`
        : videoTitle
        ? `Pick the single BEST trending song for a short-form video titled: "${videoTitle}".${contextNote}
Target platforms: ${platformList}.
Choose a well-known, currently popular song that fits the video's likely mood and maximises viral potential.`
        : `Pick the single BEST trending song for a short-form video.${contextNote || ' No title is available.'}
Target platforms: ${platformList}.
Choose a well-known, currently popular upbeat or lifestyle song that maximises viral potential.`;

    } else if (type === 'title') {
      systemPrompt = `You are a social media content strategist who writes hyper-specific, descriptive video titles for TikTok, Instagram Reels, and YouTube Shorts.
Your titles name the ACTUAL subject: the person (e.g. "My Daughter", "Baby", "Toddler", "My Dog"), the exact action they are doing (e.g. "Hopping", "Dancing", "Trying Sushi for the First Time"), and any notable detail.
NEVER write vague titles like "Fun Video", "Amazing Moment", "Check This Out", "Incredible Clip".
Always write as if you are the creator sharing a personal moment.
${visualContext}
${SAFETY_RULES}
Return ONLY the title — 4–10 words, no hashtags, no quotes, no explanation.`;

      userPrompt = hasFrame
        ? `Look carefully at this video frame and identify:
1. WHO is in the video (child, baby, adult, dog, cat, etc.)
2. WHAT they are doing (exact action — jumping, laughing, eating, dancing, etc.)
3. WHERE or any notable context (outdoors, kitchen, park, etc.)

Write a specific, personal title that captures exactly what is happening in this video.
Examples of good titles: "My Daughter Hopping Around the Backyard", "Baby's First Taste of Ice Cream", "Our Dog Refuses to Move Off the Couch".
Current filename for extra context: "${videoTitle}".
Return ONLY the title, 4–10 words.`
        : `Write a specific, personal video title for a short-form video. Current filename: "${videoTitle}".
Infer the likely subject and action from the filename if possible. Use personal framing like "My...", "Our...", or the subject directly.
Examples: "My Daughter Hopping for Fun", "Toddler Tries Broccoli for the First Time".
Return ONLY the title, 4–10 words.`;

    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid type. Use: hook, caption, audio, or title' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const userContent = buildUserContent(userPrompt, rawFrames);

    const rawContent = await callAnthropic(ANTHROPIC_MODEL, systemPrompt, userContent, 512, 0.75);
    console.log(`[ai-content-generator] raw response (first 200 chars): ${rawContent.slice(0, 200)}`);

    if (type === 'title') {
      const text = rawContent.replace(/^["']|["']$/g, '').trim();
      return new Response(
        JSON.stringify({ result: text }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

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
