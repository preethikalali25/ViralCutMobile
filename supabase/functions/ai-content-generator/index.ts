import { corsHeaders } from '../_shared/cors.ts';

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

function sanitizeTitle(raw: string): string {
  return raw
    .replace(/\.[a-zA-Z0-9]{2,5}$/, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\b\d{4,}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || 'my video';
}

const SAFETY_RULES = `
CRITICAL RULES — follow these without exception:
- NEVER ask the user for clarification or more information. ALWAYS generate output immediately.
- NEVER say "I need more details", "could you provide", or any variation of requesting more context.
- If the title is generic or vague, invent a plausible, positive scenario and write for that. Make it work.
- Never produce offensive, hateful, sexually suggestive, violent, or discriminatory content.
- Write content suitable for all ages and appropriate for mainstream social media platforms.
`;

function buildUserContent(
  userPrompt: string,
  videoFrameBase64?: string,
  videoFrameMime = 'image/jpeg',
) {
  if (videoFrameBase64) {
    return [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: videoFrameMime,
          data: videoFrameBase64,
        },
      },
      { type: 'text', text: userPrompt },
    ];
  }
  return userPrompt;
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
      videoFrameBase64,
      videoFrameMime = 'image/jpeg',
    } = body;

    const videoTitle = sanitizeTitle(rawTitle ?? '');
    // Reject frames larger than 200KB base64 (~150KB image) to avoid timeouts
    const hasFrame = typeof videoFrameBase64 === 'string'
      && videoFrameBase64.length > 100
      && videoFrameBase64.length < 200_000;
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
Your hooks are punchy, specific, and under 80 characters.
${visualContext}
${SAFETY_RULES}
Output ONLY the hook text — no quotes, no labels, no explanation, no questions.`;

      userPrompt = hasFrame
        ? `Write ${hookStyle} for this video. Base it on what you actually see in the frame.
Video title for extra context: "${videoTitle}". Hook style: ${hookType}. Under 80 characters.`
        : `Write ${hookStyle} for a short-form video titled: "${videoTitle}".
Hook style: ${hookType}. Under 80 characters. If the title is vague, pick a relatable everyday moment and write for that. Output only the hook.`;

    } else if (type === 'caption') {
      const platformList = (platforms as string[]).join(', ');

      systemPrompt = `You are a viral content strategist writing captions and hashtags for short-form video platforms.
${visualContext}
${SAFETY_RULES}
Return a JSON object with exactly two fields:
- "caption": 1–3 engaging, conversational sentences optimised for the target platforms.
- "hashtags": a space-separated string of 5–8 trending, relevant hashtags (include #fyp, #viral, or platform-specific tags).
Return ONLY valid JSON — no markdown, no code blocks, no questions, no extra text.`;

      userPrompt = hasFrame
        ? `Write a caption and hashtags based on what you see in this video frame. Video title: "${videoTitle}". Target platforms: ${platformList}.`
        : `Write a caption and hashtags for a short-form video titled: "${videoTitle}". Target platforms: ${platformList}. If the title is generic, write for a relatable everyday moment. Return JSON only.`;

    } else if (type === 'audio') {
      const platformList = (platforms as string[]).join(', ');

      systemPrompt = `You are a viral music curator specialising in Hindi, Bollywood, and Punjabi songs trending on Instagram Reels and TikTok.
Identify the content category of the video, then pick the single BEST Hindi/Punjabi/Bollywood song that creators in that exact niche are going viral with right now.
Always suggest Hindi or Punjabi songs — never English songs.
Top trending Hindi/Punjabi songs to consider: Tauba Tauba (Karan Aujla), Kesariya (Arijit Singh), Pasoori (Ali Sethi & Shae Gill), Tum Kya Mile (Arijit Singh), GOAT (Diljit Dosanjh), Softly (Karan Aujla), Heeriye (Jasleen Royal ft. Arijit Singh), Raataan Lambiyan (Jubin Nautiyal), Apna Bana Le (Arijit Singh), Brown Munde (AP Dhillon), Excuses (AP Dhillon), Lover (Diljit Dosanjh), Tere Vaaste (Varun Jain), Nain Tare (Darshan Raval), Ranjha (Shershaah OST).
${visualContext}
${SAFETY_RULES}
Return a single JSON object:
{ "id": "ai_best", "title": "Song Title", "artist": "Artist Name", "uses": "e.g. 2.4M uses", "trending": true, "platform": ["tiktok","reels","youtube"], "mood": "one word mood", "reason": "one sentence explaining why this Hindi song fits this video" }
Return ONLY valid JSON — no markdown, no code blocks, no questions, no extra text.`;

      userPrompt = hasFrame
        ? `Analyse this video frame. Identify the content category and pick the single BEST trending Hindi or Punjabi song for that category.
Video title: "${videoTitle}". Target platforms: ${platformList}. Return JSON only.`
        : `Video title: "${videoTitle}". Target platforms: ${platformList}.
Pick the single BEST trending Hindi or Punjabi song that fits this video's likely content. Return JSON only.`;

    } else if (type === 'audio_suggestions') {
      const platformList = (platforms as string[]).join(', ');

      systemPrompt = `You are a viral music curator specialising in Hindi, Bollywood, and Punjabi songs trending on Instagram Reels and TikTok.
Your job: identify the content category of the video, then suggest 5 trending Hindi/Punjabi/Bollywood songs that creators in that exact niche are going viral with.
Always suggest Hindi or Punjabi songs — never English songs.

Category → song style guide:
- Baby/kids/family → soft, emotional Bollywood (e.g. Kesariya, Tum Kya Mile, Heeriye, Apna Bana Le, Raataan Lambiyan)
- Funny/comedy/pets → upbeat, fun Punjabi (e.g. Tauba Tauba, GOAT, Lover, Softly, Brown Munde)
- Fitness/workout/sports → high-energy Punjabi hype (e.g. GOAT, Brown Munde, Excuses, Insane AP Dhillon, Softly)
- Food/cooking/lifestyle → chill, aesthetic Bollywood (e.g. Kesariya, Pasoori, Tere Vaaste, Nain Tare, Ranjha)
- Travel/nature/outdoors → cinematic, uplifting (e.g. Kesariya, Pasoori, Heeriye, Tum Kya Mile, Ranjha)
- Dance/performance → beat-driven Punjabi (e.g. Tauba Tauba, GOAT, Lover, Brown Munde, Excuses)
- Fashion/beauty → trendy, cool Punjabi (e.g. Tauba Tauba, Softly, Excuses, AP Dhillon tracks, Diljit tracks)
- Romance/relationship → romantic Bollywood (e.g. Kesariya, Tum Kya Mile, Apna Bana Le, Tere Vaaste, Nain Tare)
- Motivation/inspiration → powerful Bollywood/Punjabi (e.g. Heeriye, Ranjha, Excuses, Brown Munde)

${visualContext}
${SAFETY_RULES}
Return a JSON array of exactly 5 objects — each a real Hindi/Punjabi/Bollywood song:
[{ "id": "sug_1", "title": "Song Title", "artist": "Artist Name", "uses": "e.g. 4.2M uses", "trending": true/false }, ...]
IDs must be "sug_1" through "sug_5".
Return ONLY a valid JSON array — no markdown, no code blocks, no questions, no extra text.`;

      userPrompt = hasFrame
        ? `Analyse this video frame. Identify the content category and mood, then suggest 5 trending Hindi/Punjabi/Bollywood songs that fit this exact type of content on ${platformList}.
Video title for extra context: "${videoTitle}". Return only the JSON array.`
        : `Video title: "${videoTitle}". Target platforms: ${platformList}.
Identify the content category and suggest 5 trending Hindi/Punjabi/Bollywood songs that fit. Return only the JSON array.`;

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
        JSON.stringify({ error: 'Invalid type. Use: hook, caption, audio, audio_suggestions, or title' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const userContent = buildUserContent(
      userPrompt,
      hasFrame ? videoFrameBase64 : undefined,
      videoFrameMime,
    );

    const aiResponse = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(25000),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
        temperature: 0.75,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error('Anthropic API error:', errText);
      return new Response(
        JSON.stringify({ error: `AI service error: ${errText}` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const aiData = await aiResponse.json();
    const rawContent = (aiData.content?.[0]?.text ?? '').trim();
    console.log(`[ai-content-generator] raw response (first 200 chars): ${rawContent.slice(0, 200)}`);

    if (type === 'hook' || type === 'title') {
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
