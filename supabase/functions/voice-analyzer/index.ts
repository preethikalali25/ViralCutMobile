import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ASSEMBLYAI_URL = 'https://api.assemblyai.com/v2';

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
    const { action, videoId, userId, videoUrl, transcriptId, enhancementId, speakersExpected } = body;

    // ── Submit analysis (AssemblyAI speaker diarization) ──
    if (action === 'submit') {
      const assemblyKey = getEnv('ASSEMBLYAI_API_KEY');
      if (!videoUrl || !userId || !videoId) {
        return new Response(JSON.stringify({ error: 'Missing videoUrl, userId, or videoId' }), { status: 400, headers: corsHeaders });
      }

      // Create DB record
      const { data: record, error: insertErr } = await supabase
        .from('voice_enhancements')
        .insert({ video_id: videoId, user_id: userId, status: 'analyzing' })
        .select('id')
        .single();
      if (insertErr) return new Response(JSON.stringify({ error: `DB insert failed: ${insertErr.message}` }), { status: 500, headers: corsHeaders });

      // Submit AssemblyAI transcript with speaker diarization
      // Default to 2 speakers — AAI auto-detect often collapses to 1 without a hint
      const resolvedSpeakers = (speakersExpected && speakersExpected >= 1) ? speakersExpected : 2;
      const aaiPayload: Record<string, unknown> = {
        audio_url: videoUrl,
        speaker_labels: true,
        speakers_expected: resolvedSpeakers,
      };
      console.log('[voice-analyzer] AAI payload:', JSON.stringify(aaiPayload).slice(0, 200));

      const aaiRes = await fetch(`${ASSEMBLYAI_URL}/transcript`, {
        method: 'POST',
        headers: { authorization: assemblyKey, 'content-type': 'application/json' },
        body: JSON.stringify(aaiPayload),
      });
      const aaiData = await aaiRes.json();
      console.log('[voice-analyzer] AAI submit status:', aaiRes.status, 'id:', aaiData.id, 'error:', aaiData.error);
      if (aaiData.error) {
        await supabase.from('voice_enhancements').update({ status: 'failed', error_message: aaiData.error }).eq('id', record.id);
        return new Response(JSON.stringify({ error: `AssemblyAI: ${aaiData.error}` }), { status: 500, headers: corsHeaders });
      }

      await supabase.from('voice_enhancements').update({
        assemblyai_id: aaiData.id,
        updated_at: new Date().toISOString(),
      }).eq('id', record.id);

      return new Response(JSON.stringify({
        enhancementId: record.id,
        transcriptId: aaiData.id,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── Poll AssemblyAI status ──
    if (action === 'poll-transcript') {
      const assemblyKey = getEnv('ASSEMBLYAI_API_KEY');
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
          start: u.start,
          end: u.end,
          text: u.text,
        }));

        await supabase.from('voice_enhancements').update({
          speaker_count: speakerCount,
          speaker_segments: speakerSegments,
          status: 'ready',
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
    console.error('[voice-analyzer] unhandled error:', String(err));
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
