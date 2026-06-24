-- tiktok_tokens: stores OAuth tokens per user
create table if not exists public.tiktok_tokens (
  user_id             uuid        primary key references auth.users(id) on delete cascade,
  open_id             text        not null,
  access_token        text        not null,
  refresh_token       text,
  expires_at          timestamptz not null,
  refresh_expires_at  timestamptz,
  scope               text        not null default '',
  creator_name        text        not null default '',
  creator_avatar_url  text        not null default '',
  updated_at          timestamptz not null default now()
);

alter table public.tiktok_tokens enable row level security;

-- Authenticated users may read their own row (e.g. to show connection status)
create policy "Users can read own TikTok token row"
  on public.tiktok_tokens for select
  to authenticated
  using (auth.uid() = user_id);

-- Only service-role (edge functions) may insert/update/delete
-- (no policy = blocked for non-service-role writes, which is correct)
