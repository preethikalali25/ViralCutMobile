create table if not exists public.voice_mix_jobs (
  id               uuid primary key default gen_random_uuid(),
  video_id         text not null,
  user_id          uuid not null references auth.users(id) on delete cascade,
  input_url        text not null,
  speaker_segments jsonb not null,
  speaker_volumes  jsonb not null,
  output_url       text,
  render_job_id    text,
  status           text not null default 'pending',
  error_message    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.voice_mix_jobs enable row level security;

create policy "Users manage own mix jobs"
  on public.voice_mix_jobs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Add enhanced_video_url to scheduled_posts so scheduler prefers the mixed audio version
alter table public.scheduled_posts
  add column if not exists enhanced_video_url text;
