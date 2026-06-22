-- youtube_tokens: stores Google OAuth tokens and YouTube channel info per user
create table if not exists public.youtube_tokens (
  user_id           uuid        primary key references public.user_profiles(id) on delete cascade,
  google_user_id    text        not null default '',
  access_token      text        not null,
  refresh_token     text        not null default '',
  expires_at        timestamptz not null,
  channel_id        text        not null default '',
  channel_title     text        not null default '',
  channel_thumbnail text        not null default '',
  updated_at        timestamptz not null default now()
);

alter table public.youtube_tokens enable row level security;

create policy "authenticated_select_own_youtube_tokens"
  on public.youtube_tokens for select
  to authenticated
  using (user_id = auth.uid());

create policy "authenticated_insert_own_youtube_tokens"
  on public.youtube_tokens for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "authenticated_update_own_youtube_tokens"
  on public.youtube_tokens for update
  to authenticated
  using (user_id = auth.uid());

create policy "authenticated_delete_own_youtube_tokens"
  on public.youtube_tokens for delete
  to authenticated
  using (user_id = auth.uid());

-- SECURITY DEFINER function so the edge function (service role) can upsert
-- without PostgREST RLS conflicts
create or replace function public.upsert_youtube_token(
  p_user_id           uuid,
  p_google_user_id    text,
  p_access_token      text,
  p_refresh_token     text,
  p_expires_at        timestamptz,
  p_channel_id        text,
  p_channel_title     text,
  p_channel_thumbnail text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.youtube_tokens (
    user_id, google_user_id, access_token, refresh_token,
    expires_at, channel_id, channel_title, channel_thumbnail, updated_at
  ) values (
    p_user_id, p_google_user_id, p_access_token, p_refresh_token,
    p_expires_at, p_channel_id, p_channel_title, p_channel_thumbnail, now()
  )
  on conflict (user_id) do update set
    google_user_id    = excluded.google_user_id,
    access_token      = excluded.access_token,
    refresh_token     = excluded.refresh_token,
    expires_at        = excluded.expires_at,
    channel_id        = excluded.channel_id,
    channel_title     = excluded.channel_title,
    channel_thumbnail = excluded.channel_thumbnail,
    updated_at        = now();
end;
$$;
