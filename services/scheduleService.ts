import { getSupabaseClient } from '@/template';

export interface ScheduledPostPayload {
  user_id: string;
  platform: 'tiktok' | 'reels' | 'youtube';
  video_url: string;
  title: string;
  caption: string;
  hashtags: string;
  hook_text: string;
  privacy_level: string;
  scheduled_at: string;
}

export async function saveScheduledPost(payload: ScheduledPostPayload): Promise<{ id: string } | { error: string }> {
  const supabase = getSupabaseClient();
  console.log('[scheduleService] inserting post:', payload.platform);

  const { data, error } = await supabase
    .from('scheduled_posts')
    .insert({
      user_id: payload.user_id,
      platform: payload.platform,
      video_url: payload.video_url,
      title: payload.title,
      caption: payload.caption,
      hashtags: payload.hashtags,
      hook_text: payload.hook_text,
      privacy_level: payload.privacy_level,
      scheduled_at: payload.scheduled_at,
    })
    .select('id')
    .single();

  console.log('[scheduleService] insert data:', JSON.stringify(data));
  console.log('[scheduleService] insert error:', JSON.stringify(error));

  if (error) return { error: `[${error.code}] ${error.message} | ${error.details}` };
  return { id: data.id as string };
}

export async function getScheduledPosts(userId: string) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('scheduled_posts')
    .select('*')
    .eq('user_id', userId)
    .order('scheduled_at', { ascending: true });

  if (error) return { posts: [], error: error.message };
  return { posts: data ?? [] };
}

export async function deleteScheduledPost(id: string): Promise<{ error?: string }> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('scheduled_posts')
    .delete()
    .eq('id', id);

  if (error) return { error: error.message };
  return {};
}
