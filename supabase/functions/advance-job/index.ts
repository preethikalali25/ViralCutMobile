import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import { getSupabaseAdmin, getSupabaseForRequest } from "../_shared/supabaseAdmin.ts";

const ALLOWED_TARGET_LANGUAGES = ["hindi", "telugu", "tamil", "kannada", "bengali"];
const ALLOWED_AVATAR_GENDERS = ["male", "female"];
const ALLOWED_AVATAR_STYLES = ["professional", "casual", "news_anchor"];
const MAX_UPLOAD_DURATION_SECONDS = 180;
const MAX_UPLOAD_SIZE_MB = 300;
const MAX_JOBS_PER_HOUR = 10;

interface CreateJobBody {
  title: string;
  sourceLang: string;
  targetLanguage: string;
  avatarGender: string;
  avatarStyle: string;
  avatarName: string;
  sourceStoragePath: string;
  sourceFileName?: string;
  sourceDurationSeconds?: number;
  sourceSizeBytes?: number;
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: CreateJobBody;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid JSON body");
  }

  if (!body.title || !body.sourceLang || !body.sourceStoragePath) {
    return badRequest("title, sourceLang, and sourceStoragePath are required");
  }
  if (!ALLOWED_TARGET_LANGUAGES.includes(body.targetLanguage)) {
    return badRequest(`targetLanguage must be one of ${ALLOWED_TARGET_LANGUAGES.join(", ")}`);
  }
  if (!ALLOWED_AVATAR_GENDERS.includes(body.avatarGender)) {
    return badRequest(`avatarGender must be one of ${ALLOWED_AVATAR_GENDERS.join(", ")}`);
  }
  if (!ALLOWED_AVATAR_STYLES.includes(body.avatarStyle)) {
    return badRequest(`avatarStyle must be one of ${ALLOWED_AVATAR_STYLES.join(", ")}`);
  }
  if (body.sourceDurationSeconds && body.sourceDurationSeconds > MAX_UPLOAD_DURATION_SECONDS) {
    return badRequest(`video duration exceeds the ${MAX_UPLOAD_DURATION_SECONDS}s v1 cap`);
  }
  if (body.sourceSizeBytes && body.sourceSizeBytes > MAX_UPLOAD_SIZE_MB * 1024 * 1024) {
    return badRequest(`video size exceeds the ${MAX_UPLOAD_SIZE_MB}MB v1 cap`);
  }

  const userClient = getSupabaseForRequest(req);
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userId = userData.user.id;

  const admin = getSupabaseAdmin();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await admin
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", oneHourAgo);
  if (countError) {
    return new Response(JSON.stringify({ error: countError.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if ((count ?? 0) >= MAX_JOBS_PER_HOUR) {
    return new Response(JSON.stringify({ error: "rate limit exceeded, try again later" }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Insert via the user-scoped client so RLS's `jobs_insert_own` policy
  // (auth.uid() = user_id) enforces ownership naturally.
  const { data: job, error: insertError } = await userClient
    .from("jobs")
    .insert({
      user_id: userId,
      title: body.title,
      source_lang: body.sourceLang,
      target_language: body.targetLanguage,
      avatar_gender: body.avatarGender,
      avatar_style: body.avatarStyle,
      avatar_name: body.avatarName,
      input_method: "upload",
      source_storage_path: body.sourceStoragePath,
      source_file_name: body.sourceFileName ?? null,
      source_duration_seconds: body.sourceDurationSeconds ?? null,
      source_size_bytes: body.sourceSizeBytes ?? null,
    })
    .select("id")
    .single();

  if (insertError || !job) {
    return new Response(JSON.stringify({ error: insertError?.message ?? "insert failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Kick the first pipeline step immediately rather than waiting for the
  // next ~20s cron tick. Fire-and-forget: don't make the caller wait for an
  // entire pipeline step (which can involve a slow Gemini call) just to get
  // back a job id.
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  fetch(`${supabaseUrl}/functions/v1/advance-job`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ job_id: job.id }),
  }).catch((err) => console.error("Failed to kick advance-job:", err));

  return new Response(JSON.stringify({ id: job.id }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
