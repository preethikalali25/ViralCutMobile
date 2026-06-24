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
  const { data, error } = await supabase
    .from('scheduled_posts')
    .insert(payload)
    .select('id')
    .single();

  if (error) return { error: error.message };
  return { id: data.id };
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
