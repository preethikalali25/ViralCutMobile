import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ASSEMBLYAI_URL = 'https://api.assemblyai.com/v2';
const DOLBY_BASE_URL = 'https://api.dolby.io/media';

function getEnv(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'));
    const assemblyKey = getEnv('ASSEMBLYAI_API_KEY');
    const dolbyKey = getEnv('DOLBY_API_KEY');
    const dolbySecret = getEnv('DOLBY_API_SECRET');

    const body = await req.json();
    const { action, videoId, userId, videoUrl, transcriptId, dolbyJobId, enhancementId } = body;

    // ── Submit analysis (AssemblyAI diarization + Dolby.io enhance in parallel) ──
    if (action === 'submit') {
      if (!videoUrl || !userId || !videoId) {
        return new Response(JSON.stringify({ error: 'Missing videoUrl, userId, or videoId' }), { status: 400, headers: corsHeaders });
      }

      // Create DB record
      const { data: record, error: insertErr } = await supabase
        .from('voice_enhancements')
        .insert({ video_id: videoId, user_id: userId, status: 'analyzing' })
        .select('id')
        .single();
      if (insertErr) return new Response(JSON.stringify({ error: insertErr.message }), { status: 500, headers: corsHeaders });

      // Submit AssemblyAI transcript
      const aaiRes = await fetch(`${ASSEMBLYAI_URL}/transcript`, {
        method: 'POST',
        headers: { authorization: assemblyKey, 'content-type': 'application/json' },
        body: JSON.stringify({ audio_url: videoUrl, speaker_labels: true }),
      });
      const aaiData = await aaiRes.json();
      if (aaiData.error) {
        await supabase.from('voice_enhancements').update({ status: 'failed', error_message: aaiData.error }).eq('id', record.id);
        return new Response(JSON.stringify({ error: aaiData.error }), { status: 500, headers: corsHeaders });
      }

      // Submit Dolby.io enhance job
      const dolbyToken = btoa(`${dolbyKey}:${dolbySecret}`);
      const dolbyRes = await fetch(`${DOLBY_BASE_URL}/enhance`, {
        method: 'POST',
        headers: { authorization: `Basic ${dolbyToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          input: videoUrl,
          output: `dlb://out/enhanced_${videoId}_${Date.now()}.mp4`,
          audio: {
            noise: { reduction: { enable: true } },
            speech: { isolation: { enable: true, amount: 70 } },
          },
        }),
      });
      const dolbyData = await dolbyRes.json();

      await supabase.from('voice_enhancements').update({
        assemblyai_id: aaiData.id,
        dolby_job_id: dolbyData.job_id ?? null,
        updated_at: new Date().toISOString(),
      }).eq('id', record.id);

      return new Response(JSON.stringify({
        enhancementId: record.id,
        transcriptId: aaiData.id,
        dolbyJobId: dolbyData.job_id ?? null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── Poll AssemblyAI status ──
    if (action === 'poll-transcript') {
      if (!transcriptId || !enhancementId) {
        return new Response(JSON.stringify({ error: 'Missing transcriptId or enhancementId' }), { status: 400, headers: corsHeaders });
      }
      const res = await fetch(`${ASSEMBLYAI_URL}/transcript/${transcriptId}`, {
        headers: { authorization: assemblyKey },
      });
      const data = await res.json();

      if (data.status === 'completed') {
        const speakerCount = new Set(data.utterances?.map((u: any) => u.speaker) ?? []).size;
        const speakerSegments = (data.utterances ?? []).map((u: any) => ({
          speaker: u.speaker,
          start: u.start,  // ms
          end: u.end,      // ms
          text: u.text,
        }));

        await supabase.from('voice_enhancements').update({
          speaker_count: speakerCount,
          speaker_segments: speakerSegments,
          updated_at: new Date().toISOString(),
        }).eq('id', enhancementId);

        return new Response(JSON.stringify({ status: 'completed', speakerCount, speakerSegments }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (data.status === 'error') {
        await supabase.from('voice_enhancements').update({ status: 'failed', error_message: data.error }).eq('id', enhancementId);
        return new Response(JSON.stringify({ status: 'error', error: data.error }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ status: data.status }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Poll Dolby.io enhance status ──
    if (action === 'poll-enhance') {
      if (!dolbyJobId || !enhancementId) {
        return new Response(JSON.stringify({ error: 'Missing dolbyJobId or enhancementId' }), { status: 400, headers: corsHeaders });
      }
      const dolbyToken = btoa(`${dolbyKey}:${dolbySecret}`);
      const res = await fetch(`${DOLBY_BASE_URL}/enhance?job_id=${dolbyJobId}`, {
        headers: { authorization: `Basic ${dolbyToken}` },
      });
      const data = await res.json();

      if (data.status === 'Success') {
        // Download enhanced file URL from Dolby.io output
        const outputRes = await fetch(`${DOLBY_BASE_URL}/output?url=${encodeURIComponent(data.result?.media ?? '')}`, {
          headers: { authorization: `Basic ${dolbyToken}` },
        });
        const outputData = await outputRes.json();
        const enhancedUrl = outputData.url ?? null;

        if (enhancedUrl) {
          await supabase.from('voice_enhancements').update({
            enhanced_url: enhancedUrl,
            status: 'ready',
            updated_at: new Date().toISOString(),
          }).eq('id', enhancementId);
        }

        return new Response(JSON.stringify({ status: 'completed', enhancedUrl }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (data.status === 'Failed') {
        await supabase.from('voice_enhancements').update({ status: 'failed', error_message: 'Dolby.io enhance failed' }).eq('id', enhancementId);
        return new Response(JSON.stringify({ status: 'error' }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ status: data.status ?? 'pending' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Get cached enhancement from DB ──
    if (action === 'get') {
      if (!videoId || !userId) {
        return new Response(JSON.stringify({ error: 'Missing videoId or userId' }), { status: 400, headers: corsHeaders });
      }
      const { data } = await supabase
        .from('voice_enhancements')
        .select('*')
        .eq('video_id', videoId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      return new Response(JSON.stringify({ enhancement: data }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: corsHeaders });

  } catch (err) {
    console.error('[voice-analyzer] error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
