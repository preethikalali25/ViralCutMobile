-- youtube_tokens: stores OAuth tokens per user
create table if not exists public.youtube_tokens (
  user_id           uuid        primary key references auth.users(id) on delete cascade,
  google_user_id    text        not null,
  access_token      text        not null,
  refresh_token     text        not null default '',
  expires_at        timestamptz not null,
  channel_id        text        not null default '',
  channel_title     text        not null default '',
  channel_thumbnail text        not null default '',
  updated_at        timestamptz not null default now()
);

alter table public.youtube_tokens enable row level security;

-- Authenticated users may read their own row
create policy "Users can read own YouTube token row"
  on public.youtube_tokens for select
  to authenticated
  using (auth.uid() = user_id);
