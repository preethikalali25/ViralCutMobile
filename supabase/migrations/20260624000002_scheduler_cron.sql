-- Enable required extensions (may already be enabled in your Supabase project)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Schedule the scheduler Edge Function to run every minute.
-- IMPORTANT: Replace the two placeholders below with your actual values:
--   YOUR_PROJECT_REF  → find in Supabase Dashboard > Settings > General (e.g. mrsvovoywukechawmrsv)
--   YOUR_SERVICE_ROLE_KEY → find in Supabase Dashboard > Settings > API > service_role key
--
-- Run this in Supabase Dashboard > SQL Editor after deploying the scheduler function.

select cron.schedule(
  'process-scheduled-posts',
  '* * * * *',
  $$
  select net.http_post(
    url        := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/scheduler',
    headers    := '{"Content-Type":"application/json","Authorization":"Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body       := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
