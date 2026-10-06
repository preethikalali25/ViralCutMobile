import { corsHeaders } from '../_shared/cors.ts';

const SONNET = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

interface KeyFrame {
  timestampSec: number;
  base64: string;
}

interface TemplateClip {
  id: string;
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  description: string;
  textOverlay?: string;
  transitionType: 'cut' | 'fade' | 'dissolve' | 'slide';
  originalThumbnail: string;
}

interface ReelTemplateResult {
  totalDuration: number;
  clipCount: number;
  style: {
    vibe: string;
    pacing: 'fast' | 'medium' | 'slow';
    colorGrade: string;
    musicGenre: string;
    musicQuery: string;
  };
  clips: TemplateClip[];
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
    const { frames, totalDurationSec } = body as { frames: KeyFrame[]; totalDurationSec: number };

    if (!frames?.length) {
      return new Response(
        JSON.stringify({ error: 'No frames provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Build vision message with all keyframes
    const imageBlocks = frames.map((f) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: f.base64 },
    }));

    const timestampList = frames.map((f) => `t=${f.timestampSec.toFixed(1)}s`).join(', ');

    const systemPrompt = `You are a video template analyzer. You analyze sequences of video frames and identify the structure of a short-form video reel (Instagram Reel, TikTok, YouTube Short).

Your job is to identify:
1. How many distinct clips/scenes exist
2. The approximate start and end time of each clip (based on visible frame timestamps)
3. A brief description of what each clip shows (useful as a placeholder label)
4. Any visible text overlays
5. The visual style, pacing, color grade, and suggested music genre

Always return valid JSON matching the exact schema provided. Never include markdown fences.`;

    const userPrompt = `These ${frames.length} frames are extracted from a ${totalDurationSec.toFixed(1)}-second reel at timestamps: ${timestampList}.

Analyze the frames and return a JSON object with this EXACT structure:
{
  "totalDuration": <number, seconds>,
  "clipCount": <number>,
  "style": {
    "vibe": "<one-line vibe description, e.g. aesthetic lifestyle, high-energy fitness>",
    "pacing": "<fast|medium|slow>",
    "colorGrade": "<warm|cool|vibrant|muted|moody|bright>",
    "musicGenre": "<genre, e.g. lo-fi chill, hype hip-hop, acoustic pop>",
    "musicQuery": "<4-6 word search query for viral audio matching this vibe>"
  },
  "clips": [
    {
      "id": "clip_0",
      "index": 0,
      "startTime": <seconds>,
      "endTime": <seconds>,
      "duration": <seconds>,
      "description": "<what this slot shows, e.g. 'Morning coffee close-up, warm kitchen'>",
      "textOverlay": "<text if visible on screen, or null>",
      "transitionType": "<cut|fade|dissolve|slide>"
    }
  ]
}

Rules:
- Identify scene changes by looking for abrupt visual shifts between consecutive frames
- Each clip should be at least 0.5 seconds
- Use the frame timestamps to estimate clip start/end times
- description should be a useful placeholder label for the user replacing this slot
- Return ONLY the JSON object, no markdown, no explanation`;

    const res = await fetch(API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SONNET,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: userPrompt },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic error ${res.status}: ${err}`);
    }

    const data = await res.json() as { content: { type: string; text: string }[] };
    const rawText = data.content.find((b) => b.type === 'text')?.text ?? '';

    let parsed: ReelTemplateResult;
    try {
      parsed = JSON.parse(rawText.trim());
    } catch {
      // Try to extract JSON from response if it has extra text
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('AI returned invalid JSON');
      parsed = JSON.parse(jsonMatch[0]);
    }

    // Attach the original thumbnail to each clip using the closest keyframe
    parsed.clips = parsed.clips.map((clip) => {
      const midpoint = (clip.startTime + clip.endTime) / 2;
      const closest = frames.reduce((best, f) =>
        Math.abs(f.timestampSec - midpoint) < Math.abs(best.timestampSec - midpoint) ? f : best
      );
      return { ...clip, originalThumbnail: closest.base64 };
    });

    return new Response(
      JSON.stringify(parsed),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[analyze-template]', msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
