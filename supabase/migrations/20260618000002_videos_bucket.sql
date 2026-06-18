-- Public storage bucket for videos uploaded before pushing to TikTok / Instagram
-- TikTok's Content Posting API (PULL_FROM_URL) requires a publicly accessible URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'videos',
  'videos',
  true,          -- must be public so TikTok can fetch the URL
  524288000,     -- 500 MB limit
  array['video/mp4', 'video/quicktime', 'video/x-m4v']
)
on conflict (id) do update set
  public            = excluded.public,
  file_size_limit   = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Allow authenticated users to upload their own videos
create policy "Authenticated users can upload videos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Allow authenticated users to update/overwrite their own videos
create policy "Authenticated users can update own videos"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Allow authenticated users to delete their own videos
create policy "Authenticated users can delete own videos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Public read (required for TikTok PULL_FROM_URL)
create policy "Public can read videos"
  on storage.objects for select
  to public
  using (bucket_id = 'videos');
