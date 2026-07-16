/**
 * voice-mixer edge function
 *
 * Proxy that forwards per-speaker volume mix jobs to the Render.com
 * Python+FFmpeg service. The Render service does the actual audio
 * separation by timestamp and writes the output back to Supabase Storage.
 */
import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function getEnv(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'));

    const body = await req.json();
    const { action, videoId, userId, inputUrl, speakerSegments, speakerVolumes, jobId } = body;

    // ── Submit mix job ──
    if (action === 'submit') {
      const renderUrl = getEnv('RENDER_FFMPEG_SERVICE_URL');
      if (!videoId || !userId || !inputUrl || !speakerSegments || !speakerVolumes) {
        return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: corsHeaders });
      }

      // Insert job record
      const { data: job, error: insertErr } = await supabase
        .from('voice_mix_jobs')
        .insert({
          video_id: videoId,
          user_id: userId,
          input_url: inputUrl,
          speaker_segments: speakerSegments,
          speaker_volumes: speakerVolumes,
          status: 'pending',
        })
        .select('id')
        .single();
      if (insertErr) return new Response(JSON.stringify({ error: insertErr.message }), { status: 500, headers: corsHeaders });

      // Forward to Render.com FFmpeg service
      const renderRes = await fetch(`${renderUrl}/mix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(150_000),
        body: JSON.stringify({
          jobId: job.id,
          inputUrl,
          speakerSegments,
          speakerVolumes,
          supabaseUrl: getEnv('SUPABASE_URL'),
          supabaseKey: getEnv('SUPABASE_SERVICE_ROLE_KEY'),
          outputBucket: 'videos',
          outputPath: `mixed/${userId}/${videoId}_${Date.now()}.mp4`,
        }),
      });

      if (!renderRes.ok) {
        const errText = await renderRes.text();
        await supabase.from('voice_mix_jobs').update({ status: 'failed', error_message: errText }).eq('id', job.id);
        return new Response(JSON.stringify({ error: `Render service error: ${errText.slice(0, 200)}` }), { status: 500, headers: corsHeaders });
      }

      // Render processes synchronously — job status is already 'completed' or 'failed' in DB.
      // Only update render_job_id; do NOT touch status.
      const renderData = await renderRes.json();
      await supabase.from('voice_mix_jobs').update({
        render_job_id: renderData.jobId ?? job.id,
        updated_at: new Date().toISOString(),
      }).eq('id', job.id);

      return new Response(JSON.stringify({ jobId: job.id }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Poll mix job status ──
    if (action === 'status') {
      if (!jobId) return new Response(JSON.stringify({ error: 'Missing jobId' }), { status: 400, headers: corsHeaders });

      const { data: job } = await supabase
        .from('voice_mix_jobs')
        .select('status, output_url, error_message')
        .eq('id', jobId)
        .single();

      if (!job) return new Response(JSON.stringify({ error: 'Job not found' }), { status: 404, headers: corsHeaders });

      return new Response(JSON.stringify({
        status: job.status,
        outputUrl: job.output_url ?? null,
        error: job.error_message ?? null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: corsHeaders });

  } catch (err) {
    console.error('[voice-mixer] error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
