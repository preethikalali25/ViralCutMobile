const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// Uses Replicate's flux-schnell model for fast image generation
const REPLICATE_API = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const replicateKey = Deno.env.get('REPLICATE_API_KEY');
    if (!replicateKey) {
      return new Response(
        JSON.stringify({ error: 'Image generation not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { prompt } = await req.json() as { prompt: string };
    if (!prompt?.trim()) {
      return new Response(
        JSON.stringify({ error: 'Prompt is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Enhance prompt for high-quality vertical reel visuals
    const enhancedPrompt = `${prompt.trim()}, vertical 9:16 short-form video frame, cinematic lighting, sharp focus, vibrant colors, social media aesthetic, professional photography, Instagram Reels style`;

    // Start prediction
    const startRes = await fetch(REPLICATE_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${replicateKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait',
      },
      body: JSON.stringify({
        input: {
          prompt: enhancedPrompt,
          aspect_ratio: '9:16',
          output_format: 'jpg',
          output_quality: 95,
          num_outputs: 1,
          num_inference_steps: 4,
        },
      }),
    });

    if (!startRes.ok) {
      const err = await startRes.text();
      throw new Error(`Replicate error ${startRes.status}: ${err}`);
    }

    const prediction = await startRes.json() as {
      status: string;
      output?: string[];
      error?: string;
      urls?: { get: string };
    };

    // If Prefer:wait didn't resolve, poll until done
    if (prediction.status === 'starting' || prediction.status === 'processing') {
      const pollUrl = prediction.urls?.get;
      if (!pollUrl) throw new Error('No polling URL from Replicate');

      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const pollRes = await fetch(pollUrl, {
          headers: { 'Authorization': `Bearer ${replicateKey}` },
        });
        const polled = await pollRes.json() as typeof prediction;
        if (polled.status === 'succeeded' && polled.output?.length) {
          return new Response(
            JSON.stringify({ imageUri: polled.output[0] }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }
        if (polled.status === 'failed') throw new Error(polled.error ?? 'Generation failed');
      }
      throw new Error('Generation timed out');
    }

    if (prediction.status === 'succeeded' && prediction.output?.length) {
      return new Response(
        JSON.stringify({ imageUri: prediction.output[0] }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    throw new Error(prediction.error ?? 'Generation failed');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[generate-slot-image]', msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
