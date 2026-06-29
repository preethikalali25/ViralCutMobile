create table if not exists public.voice_enhancements (
  id               uuid primary key default gen_random_uuid(),
  video_id         text not null,
  user_id          uuid not null references auth.users(id) on delete cascade,
  speaker_count    int,
  speaker_segments jsonb,
  enhanced_url     text,
  assemblyai_id    text,
  dolby_job_id     text,
  status           text not null default 'pending',
  error_message    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.voice_enhancements enable row level security;

create policy "Users manage own voice enhancements"
  on public.voice_enhancements for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
