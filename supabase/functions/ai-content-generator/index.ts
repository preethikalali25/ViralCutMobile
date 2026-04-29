import { corsHeaders } from '../_shared/cors.ts';

const AI_MODEL = 'google/gemini-3-flash-preview';

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
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { type, videoTitle, hookType, platforms } = await req.json();

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
Return ONLY the hook text, no quotes, no extra explanation.`;

      userPrompt = `Write ${hookStyle} for a video titled: "${videoTitle}".
Hook type: ${hookType}
Keep it under 80 characters. Make it viral, bold, and impossible to scroll past.`;

    } else if (type === 'caption') {
      const platformList = (platforms as string[]).join(', ');
      systemPrompt = `You are a viral content strategist who writes captions and hashtags for short-form video platforms.
You write engaging, platform-optimized captions that boost engagement.
Return a JSON object with exactly two fields: "caption" (the caption text, 1-3 sentences, engaging and conversational) and "hashtags" (a space-separated string of 5-8 trending hashtags including #fyp or #reels or #youtube as relevant).
Return ONLY valid JSON, no markdown, no code blocks.`;

      userPrompt = `Write an optimized caption and hashtags for a video titled: "${videoTitle}".
Target platforms: ${platformList}
The caption should feel authentic, drive engagement (comments/shares), and match the platform style.`;

    } else if (type === 'audio') {
      const platformList = (platforms as string[]).join(', ');
      systemPrompt = `You are a music trend analyst for short-form video platforms (TikTok, Instagram Reels, YouTube Shorts).
You recommend trending songs that match video content and boost discoverability.
Return a JSON array of exactly 5 song recommendations. Each item: { "id": "ai_1" through "ai_5", "title": "Song Title", "artist": "Artist Name", "uses": "estimated uses like 2.4M", "trending": true/false, "platform": ["tiktok","reels","youtube"] (platforms where it's trending), "mood": "one word mood" }.
Return ONLY valid JSON array, no markdown, no code blocks.`;

      userPrompt = `Recommend 5 trending songs for a short-form video titled: "${videoTitle}".
Target platforms: ${platformList}
Mix some viral hits (trending: true) with solid proven tracks (trending: false).
Make the songs feel relevant to the video topic and current trends.`;
    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid type. Use: hook, caption, or audio' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const aiResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.85,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error('AI API error:', errText);
      return new Response(
        JSON.stringify({ error: `AI service error: ${errText}` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const aiData = await aiResponse.json();
    const rawContent = aiData.choices?.[0]?.message?.content ?? '';

    if (type === 'hook') {
      return new Response(
        JSON.stringify({ result: rawContent.trim() }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // For caption and audio, parse JSON
    try {
      // Strip markdown code fences if present
      const cleaned = rawContent.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      return new Response(
        JSON.stringify({ result: parsed }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch {
      console.error('JSON parse failed, raw content:', rawContent);
      return new Response(
        JSON.stringify({ error: 'AI returned invalid format', raw: rawContent }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

  } catch (err) {
    console.error('Edge function error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
