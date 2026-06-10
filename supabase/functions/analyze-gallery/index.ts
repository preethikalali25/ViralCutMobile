import { corsHeaders } from '../_shared/cors.ts';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

type Thumbnail = { origIdx: number; label: string; count: number; base64: string };
type Suggestion = {
  id: string; title: string; hook: string; reason: string;
  galleryIndices: number[]; contentType: string;
};

async function callAI(apiKey: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await fetch(API_URL, {
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
      profileSection = '',
      captionsBlock = '',
      thumbnails: rawThumbnails = [],
      totalItems = 0,
      evCount = 0,
      igConnected = false,
    } = body;

    const thumbnails: Thumbnail[] = (rawThumbnails as Thumbnail[])
      .filter(t => typeof t.base64 === 'string' && t.base64.length > 100);

    console.log(`[analyze-gallery] thumbnails=${thumbnails.length} totalItems=${totalItems} igConnected=${igConnected}`);

    // ── Step 1: Niche determination from Instagram profile (text-only Haiku) ──
    let determinedNiche = '';
    if (igConnected && profileSection) {
      try {
        const data = await callAI(apiKey, {
          model: HAIKU,
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
        console.warn('[analyze-gallery] niche determination failed:', e);
      }
    }

    // ── Step 2: People pre-screening (Haiku vision) ───────────────────────────
    let peoplePositions = new Set<number>(thumbnails.map((_, i) => i)); // fail open

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
        ...thumbnails.map(t => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: t.base64 },
        })),
      ];
      try {
        const data = await callAI(apiKey, {
          model: HAIKU,
          max_tokens: 80,
          messages: [{ role: 'user', content: preScreenContent }],
        }, 20000) as any;
        const text = ((data.content?.[0]?.text as string) ?? '').trim();
        const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        peoplePositions = new Set<number>((parsed.people ?? []).map(Number));
      } catch (e) {
        console.warn('[analyze-gallery] people pre-screen failed, failing open:', e);
      }
    }

    const peopleEvents = thumbnails.filter((_, pos) => peoplePositions.has(pos));

    if (peopleEvents.length === 0) {
      return new Response(
        JSON.stringify({ niche: determinedNiche, suggestions: [], empty: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Step 3: Main Sonnet analysis ──────────────────────────────────────────
    const eventLines = peopleEvents
      .map((e, pos) => `  Image ${pos}: ${e.label} (${e.count} items)`)
      .join('\n');

    const userContent: unknown[] = [
      { type: 'text', text: `${profileSection}${captionsBlock}` },
      ...peopleEvents.map(e => ({
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

    const systemPrompt = `You are an expert Instagram Reels strategist who creates scroll-stopping, niche-specific content.

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
      model: SONNET,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.7,
    }, 90000) as any;

    const rawText = ((aiData.content?.[0]?.text as string) ?? '').trim();
    console.log(`[analyze-gallery] raw response (first 200 chars): ${rawText.slice(0, 200)}`);

    const cleaned = rawText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    let parsed: { niche?: string; suggestions?: Suggestion[] };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error('[analyze-gallery] JSON parse failed:', rawText);
      return new Response(
        JSON.stringify({ error: 'AI returned invalid format', raw: rawText }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const allSuggestions: Suggestion[] = parsed.suggestions
      ?? (Array.isArray(parsed) ? parsed as unknown as Suggestion[] : []);

    // Map model positions (0..M-1 within peopleEvents) back to original topEvents origIdx
    const suggestions: Suggestion[] = allSuggestions.map(s => ({
      ...s,
      galleryIndices: (s.galleryIndices ?? [])
        .map(pos => peopleEvents[pos]?.origIdx)
        .filter((idx): idx is number => idx !== undefined),
    }));

    const finalNiche = determinedNiche || parsed.niche || '';

    return new Response(
      JSON.stringify({ niche: finalNiche, suggestions, empty: false }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[analyze-gallery] error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
