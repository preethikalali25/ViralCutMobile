-- Allows a user to delete their own account and all associated data.
-- Called via supabase.rpc('delete_user_account') from the client.
-- SECURITY DEFINER runs as the function owner (postgres) so it can call auth.users delete.
CREATE OR REPLACE FUNCTION public.delete_user_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Delete user data from all tables
  DELETE FROM public.social_accounts    WHERE user_id = v_user_id;
  DELETE FROM public.videos             WHERE user_id = v_user_id;
  DELETE FROM public.scheduled_posts    WHERE user_id = v_user_id;
  DELETE FROM public.youtube_tokens     WHERE user_id = v_user_id;
  DELETE FROM public.tiktok_tokens      WHERE user_id = v_user_id;
  DELETE FROM public.instagram_tokens   WHERE user_id = v_user_id;

  -- Delete the auth user (cascades to auth.sessions, auth.identities etc.)
  DELETE FROM auth.users WHERE id = v_user_id;
END;
$$;

-- Only authenticated users can call this; the function itself checks auth.uid()
GRANT EXECUTE ON FUNCTION public.delete_user_account() TO authenticated;
