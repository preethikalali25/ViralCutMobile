-- scheduled_posts: stores videos queued for server-side publishing
create table if not exists public.scheduled_posts (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null references auth.users(id) on delete cascade,
  platform           text        not null check (platform in ('tiktok', 'reels', 'youtube')),
  video_url          text        not null,
  title              text        not null default '',
  caption            text        not null default '',
  hashtags           text        not null default '',
  hook_text          text        not null default '',
  privacy_level      text        not null default 'public',
  scheduled_at       timestamptz not null,
  status             text        not null default 'pending'
                                 check (status in ('pending', 'processing', 'published', 'failed')),
  error_message      text,
  published_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.scheduled_posts enable row level security;

-- Users can read and insert their own scheduled posts
create policy "Users can read own scheduled posts"
  on public.scheduled_posts for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert own scheduled posts"
  on public.scheduled_posts for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can delete own scheduled posts"
  on public.scheduled_posts for delete
  to authenticated
  using (auth.uid() = user_id);

-- Service role (edge functions) handles status updates — no authenticated policy needed for update

-- Index for scheduler queries
create index if not exists idx_scheduled_posts_due
  on public.scheduled_posts (status, scheduled_at)
  where status = 'pending';
