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

async function callAI(
  apiKey: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic error ${res.status}: ${err}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
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
      // gallery_analyze fields
      profileSection = '',
      captionsBlock = '',
      thumbnails: rawThumbnails = [],
      totalItems = 0,
      evCount = 0,
      igConnected = false,
    } = body;

    // ── gallery_analyze: multi-step gallery analysis pipeline ─────────────────
    if (type === 'gallery_analyze') {
      type Thumbnail = { origIdx: number; label: string; count: number; base64: string };
      type Suggestion = {
        id: string; title: string; hook: string; reason: string;
        galleryIndices: number[]; contentType: string;
      };

      const thumbnails: Thumbnail[] = (rawThumbnails as Thumbnail[])
        .filter((t: Thumbnail) => typeof t.base64 === 'string' && t.base64.length > 100);

      console.log(`[ai-content-generator] gallery_analyze thumbnails=${thumbnails.length} totalItems=${totalItems} igConnected=${igConnected}`);

      // Step 1: Niche determination from Instagram profile (text-only Haiku)
      let determinedNiche = '';
      if (igConnected && profileSection) {
        try {
          const data = await callAI(apiKey, {
            model: ANTHROPIC_MODEL,
            max_tokens: 120,
            messages: [{
              role: 'user',
              content: `You are a social media content analyst. Based ONLY on what is EXPLICITLY shown in this Instagram profile, identify the creator's content category and target audience.

${profileSection}

Rules:
- Describe the CONTENT CATEGORY (what they post), not personal circumstances or life story
- Only use information that is directly stated — do NOT infer emotions, backstory, trauma, mental health, or personal history from emotional language in captions
- Emotional words like "journey", "growth", "healing", "hard days" in captions = motivational/lifestyle content style, NOT personal trauma
  ✗ WRONG: "creator sharing their trauma healing journey"
  ✗ WRONG: "person overcoming difficult childhood experiences"
  ✓ RIGHT: "motivational lifestyle creator posting personal growth content for young women"
  ✓ RIGHT: "fitness coach sharing home workout routines for busy South Asian moms"
  ✓ RIGHT: "travel blogger documenting solo budget trips across Southeast Asia"
- If there is not enough clear content signal, return: "lifestyle content creator"
- Return ONLY the niche sentence, nothing else`,
            }],
          }, 15000) as any;
          determinedNiche = ((data.content?.[0]?.text as string) ?? '').trim();
        } catch (e) {
          console.warn('[gallery_analyze] niche determination failed:', e);
        }
      }

      // Step 2: People pre-screening (Haiku vision)
      let peoplePositions = new Set<number>(thumbnails.map((_: Thumbnail, i: number) => i));
      if (thumbnails.length > 0) {
        const preScreenContent: unknown[] = [
          {
            type: 'text',
            text: `You are a photo classifier. I will show you ${thumbnails.length} image(s) numbered 0 to ${thumbnails.length - 1} in order.

For each image answer: does it contain at least one clearly visible PERSON (face, body, or human silhouette)?
- YES → include its number
- NO  → exclude it (objects, food, landscapes, animals, buildings = NO)

Return ONLY valid JSON, no markdown: {"people":[list of image numbers that are YES]}`,
          },
          ...thumbnails.map((t: Thumbnail) => ({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: t.base64 },
          })),
        ];
        try {
          const data = await callAI(apiKey, {
            model: ANTHROPIC_MODEL,
            max_tokens: 80,
            messages: [{ role: 'user', content: preScreenContent }],
          }, 20000) as any;
          const text = ((data.content?.[0]?.text as string) ?? '').trim();
          const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
          const parsed = JSON.parse(cleaned);
          peoplePositions = new Set<number>((parsed.people ?? []).map(Number));
        } catch (e) {
          console.warn('[gallery_analyze] people pre-screen failed, failing open:', e);
        }
      }

      const peopleEvents = thumbnails.filter((_: Thumbnail, pos: number) => peoplePositions.has(pos));
      if (peopleEvents.length === 0) {
        return new Response(
          JSON.stringify({ niche: determinedNiche, suggestions: [], empty: true }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Step 3: Main Sonnet analysis
      const eventLines = peopleEvents
        .map((e: Thumbnail, pos: number) => `  Image ${pos}: ${e.label} (${e.count} items)`)
        .join('\n');

      const userContent: unknown[] = [
        { type: 'text', text: `${profileSection}${captionsBlock}` },
        ...peopleEvents.map((e: Thumbnail) => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: e.base64 },
        })),
        {
          type: 'text',
          text: `Camera roll: ${totalItems} total items across ${evCount} detected events.
These ${peopleEvents.length} thumbnail(s) (positions 0–${peopleEvents.length - 1}) contain visible people and are approved for reel creation:
${eventLines}
${determinedNiche ? `\nCreator niche (pre-determined from Instagram): "${determinedNiche}"` : ''}

Generate one niche-focused Reel idea per image. Use galleryIndices values 0–${peopleEvents.length - 1}. Return JSON only.`,
        },
      ];

      const gallerySystemPrompt = `You are an expert Instagram Reels strategist who creates scroll-stopping, niche-specific content.

${determinedNiche
  ? `CREATOR NICHE (already determined from Instagram — do NOT change it): "${determinedNiche}"
Use this exact niche for all suggestions. Echo it back in the "niche" JSON field unchanged.`
  : `Infer the creator's niche from the gallery thumbnails. Write ONE specific niche sentence:
  ✗ "lifestyle" ✗ "family" ✗ "travel"
  ✓ "first-time mom documenting toddler milestones for Indian-American parents"
  ✓ "solo budget traveller sharing hidden gems in Southeast Asia"
  ✓ "fitness coach posting workout motivation and transformation content"`}

═══ GENERATE REEL IDEAS ═══
Every image has been verified to contain a visible person. Generate one niche-branded Reel idea per image.

Transform each event through the niche lens — the event is raw material, not the topic:
  ✗ Event: beach trip → "Fun beach day" / "We had so much fun!"
  ✓ Event: beach trip, niche: mom content → "Beach day survival guide with a toddler" / "POV: packing for the beach with a toddler (15 bags later) 😅"

For each suggestion:
• TITLE (5–8 words): niche-branded, not a literal thumbnail description
• HOOK (under 80 chars):
    1. Read the creator's ACTUAL INSTAGRAM CAPTIONS provided in the user message
    2. Identify their natural voice: tone (funny/serious/motivational/casual), vocabulary,
       emoji style, how they open sentences, any recurring phrases or patterns
    3. Write the hook IN THAT EXACT SAME VOICE — it must sound like THIS person wrote it,
       not a generic social media template
    4. Vary the hook type across suggestions (question, bold statement, relatable moment,
       confession, challenge) but always in the creator's own voice
    ✗ "POV: relatable mom moment" — generic template voice
    ✓ Match their actual caption style: if they write "ok so i FINALLY did the thing 😭🙌"
       then hook should sound like "ok so i actually survived this with my toddler 😭✨"
    If no captions are available, write scroll-stopping hooks suited to the niche
• REASON: explain why this resonates with the niche audience
• galleryIndices: position(s) used (0-based, max ${peopleEvents.length - 1})
• contentType: vary across photo_montage, video_clip, mixed

Return ONLY valid JSON — no markdown, no code blocks:
{
  "niche": "Echo the pre-determined niche, or your inferred niche if not provided",
  "suggestions": [
    {
      "id": "s1",
      "title": "Niche-specific reel title",
      "hook": "Scroll-stopping hook under 80 chars",
      "reason": "Why this resonates with the niche audience",
      "galleryIndices": [0],
      "contentType": "photo_montage|video_clip|mixed"
    }
  ]
}`;

      const aiData = await callAI(apiKey, {
        model: ANTHROPIC_MODEL_SONNET,
        max_tokens: 4096,
        system: gallerySystemPrompt,
        messages: [{ role: 'user', content: userContent }],
        temperature: 0.7,
      }, 90000) as any;

      const rawText = ((aiData.content?.[0]?.text as string) ?? '').trim();
      console.log(`[gallery_analyze] raw response (first 200 chars): ${rawText.slice(0, 200)}`);

      const cleanedText = rawText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      let parsed: { niche?: string; suggestions?: Suggestion[] };
      try {
        parsed = JSON.parse(cleanedText);
      } catch {
        return new Response(
          JSON.stringify({ error: 'AI returned invalid format', raw: rawText }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const allSuggestions: Suggestion[] = parsed.suggestions
        ?? (Array.isArray(parsed) ? parsed as unknown as Suggestion[] : []);

      const suggestions: Suggestion[] = allSuggestions.map((s: Suggestion) => ({
        ...s,
        galleryIndices: (s.galleryIndices ?? [])
          .map((pos: number) => peopleEvents[pos]?.origIdx)
          .filter((idx: unknown): idx is number => idx !== undefined),
      }));

      return new Response(
        JSON.stringify({ niche: determinedNiche || parsed.niche || '', suggestions, empty: false }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    // ── end gallery_analyze ───────────────────────────────────────────────────

    const videoTitle = sanitizeTitle(rawTitle ?? '');

    // Build unified frames array — prefer new videoFrames array, fall back to legacy single-frame fields
    const rawFrames: Array<{ base64: string; mime: string }> = (() => {
      if (Array.isArray(videoFrames) && videoFrames.length > 0) {
        return (videoFrames as Array<{ base64: string; mime: string }>)
          .filter(f => typeof f.base64 === 'string' && f.base64.length > 100 && f.base64.length < 200_000)
          .slice(0, 3);
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
        ? `You are given ${rawFrames.length} frames captured at different points in the video (beginning, middle, and near end). Analyse all frames — subject, setting, action, emotion, colours, mood across the timeline — and use this as the PRIMARY source of inspiration.`
        : 'You are given a screenshot/frame captured directly from the video. Analyse the visual scene — subject, setting, action, emotion, colours, mood — and use this as the PRIMARY source of inspiration.'
      : videoTitle
      ? 'No video frame is available. Base your response on the video title and general short-form video best practices.'
      : 'No video frame or title is available. Write based on general short-form video best practices for lifestyle, creativity, and everyday moments.';

    let systemPrompt = '';
    let userPrompt = '';

    if (type === 'hook') {
      const hookStyleMap: Record<string, string> = {
        question: 'a curiosity-driven question that makes viewers desperate to keep watching',
        stat: 'a surprising fact or number that stops the scroll',
        visual: 'a vivid sensory description that sparks imagination',
      };
      const hookStyle = hookStyleMap[hookType] ?? 'a compelling hook';

      const captionsBlock = Array.isArray(creatorCaptions) && creatorCaptions.length > 0
        ? `\nCREATOR'S INSTAGRAM CAPTIONS — study these to match their exact writing voice, tone, emoji usage, and phrasing style:\n${(creatorCaptions as string[]).map((c, i) => `${i + 1}. "${c}"`).join('\n')}\nWrite the hook IN THIS EXACT VOICE — it must sound like this creator wrote it, not a generic template.`
        : '';

      systemPrompt = `You are an expert viral short-form video hook writer for TikTok, Instagram Reels, and YouTube Shorts.
Your hooks are punchy, positive, and under 80 characters.
${visualContext}
${captionsBlock}
${SAFETY_RULES}
Return ONLY the hook text — no quotes, no labels, no explanation.`;

      userPrompt = hasFrame
        ? `Look at ${rawFrames.length > 1 ? 'these video frames' : 'this video frame'} and identify the specific subject (person, child, pet, object, scene, etc.) and action.
Write ${hookStyle} that references the ACTUAL content visible in the ${rawFrames.length > 1 ? 'frames' : 'frame'}.
Video title for context: "${videoTitle || 'unknown'}". Hook style: ${hookType}.
Under 80 characters. No offensive content.`
        : videoTitle
        ? `Write ${hookStyle} for a short-form video titled: "${videoTitle}".
Hook style: ${hookType}. Keep it under 80 characters.
Be specific to the title's subject — avoid generic filler phrases. Make it curious, bold, and scroll-stopping.`
        : `Write ${hookStyle} for a short-form video. No title or preview is available.
Hook style: ${hookType}. Keep it under 80 characters.
Focus on a broadly appealing lifestyle or everyday moment angle. Make it curious, bold, and scroll-stopping.`;

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
Video title: "${videoTitle || 'unknown'}". Target platforms: ${platformList}.
Analyse the visual scene — mood, subject, action — and write authentic, engaging copy that drives comments and shares.`
        : videoTitle
        ? `Write an optimised caption and hashtags for a video titled: "${videoTitle}".
Target platforms: ${platformList}.
Make it authentic, relatable, and engagement-driven. Match the tone to each platform style.`
        : `Write an optimised caption and hashtags for a short-form video. No title is available.
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
Video title: "${videoTitle || 'unknown'}". Target platforms: ${platformList}.
Consider the visual mood, energy, subject, and setting shown in ${rawFrames.length > 1 ? 'the frames' : 'the frame'} when choosing.`
        : videoTitle
        ? `Pick the single BEST trending song for a short-form video titled: "${videoTitle}".
Target platforms: ${platformList}.
Choose a well-known, currently popular song that fits the video's likely mood and maximises viral potential.`
        : `Pick the single BEST trending song for a short-form video. No title is available.
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
