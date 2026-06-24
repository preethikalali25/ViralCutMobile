import { getSupabaseClient } from '@/template';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { Platform } from '@/types';

export interface VideoAnalyticItem {
  id: string;
  title: string;
  thumbnail: string;
  publishedAt: string;
  views: number;
  likes: number;
  shares: number;
  comments: number;
  platform: Platform;
}

export interface PlatformAnalytics {
  platform: Platform;
  connected: boolean;
  error?: string;
  needsReconnect?: boolean;
  posts: number;
  totalViews: number;
  totalLikes: number;
  totalShares: number;
  followers?: number;
  videos: VideoAnalyticItem[];
}

export interface DashboardAnalytics {
  platforms: PlatformAnalytics[];
  totalViews: number;
  totalLikes: number;
  totalShares: number;
  topVideos: VideoAnalyticItem[];
  chartData: { date: string; views: number; likes: number; shares: number }[];
}

async function invokeFunction(fn: string, action: string, payload: Record<string, unknown>) {
  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke(fn, {
    body: { action, ...payload },
  });
  if (error) {
    let msg = error.message;
    if (error instanceof FunctionsHttpError) {
      try { msg = (await error.context?.text()) ?? msg; } catch { /* ignore */ }
    }
    return { data: null, error: msg };
  }
  return { data, error: null };
}

export async function fetchTikTokAnalytics(userId: string): Promise<PlatformAnalytics> {
  const { data, error } = await invokeFunction('tiktok-publisher', 'get_analytics', { userId });
  if (error || !data) {
    return { platform: 'tiktok', connected: false, error: error ?? 'Failed', posts: 0, totalViews: 0, totalLikes: 0, totalShares: 0, videos: [] };
  }
  if (data.error) {
    return { platform: 'tiktok', connected: true, error: data.error, needsReconnect: !!data.needsReconnect, posts: 0, totalViews: 0, totalLikes: 0, totalShares: 0, videos: [] };
  }
  return {
    platform: 'tiktok',
    connected: true,
    posts: data.posts ?? 0,
    totalViews: data.totalViews ?? 0,
    totalLikes: data.totalLikes ?? 0,
    totalShares: data.totalShares ?? 0,
    videos: (data.videos ?? []).map((v: any) => ({ ...v, shares: v.shares ?? 0, platform: 'tiktok' as Platform })),
  };
}

export async function fetchInstagramAnalytics(userId: string): Promise<PlatformAnalytics> {
  const { data, error } = await invokeFunction('instagram-publisher', 'get_analytics', { userId });
  if (error || !data) {
    return { platform: 'reels', connected: false, error: error ?? 'Failed', posts: 0, totalViews: 0, totalLikes: 0, totalShares: 0, videos: [] };
  }
  if (data.error) {
    return { platform: 'reels', connected: true, error: data.error, posts: 0, totalViews: 0, totalLikes: 0, totalShares: 0, videos: [] };
  }
  return {
    platform: 'reels',
    connected: true,
    followers: data.followersCount,
    posts: data.posts ?? 0,
    totalViews: 0,
    totalLikes: data.totalLikes ?? 0,
    totalShares: 0,
    videos: (data.videos ?? []).map((v: any) => ({ ...v, shares: 0, platform: 'reels' as Platform })),
  };
}

export async function fetchYouTubeAnalytics(userId: string): Promise<PlatformAnalytics> {
  const { data, error } = await invokeFunction('youtube-publisher', 'get_analytics', { userId });
  if (error || !data) {
    return { platform: 'youtube', connected: false, error: error ?? 'Failed', posts: 0, totalViews: 0, totalLikes: 0, totalShares: 0, videos: [] };
  }
  if (data.error) {
    return { platform: 'youtube', connected: true, error: data.error, posts: 0, totalViews: 0, totalLikes: 0, totalShares: 0, videos: [] };
  }
  const videos: VideoAnalyticItem[] = (data.videos ?? []).map((v: any) => ({
    ...v,
    shares: 0,
    platform: 'youtube' as Platform,
  }));
  return {
    platform: 'youtube',
    connected: true,
    followers: data.subscribers,
    posts: data.videoCount ?? 0,
    totalViews: data.totalViews ?? 0,
    totalLikes: videos.reduce((s, v) => s + v.likes, 0),
    totalShares: 0,
    videos,
  };
}

function buildChartData(allVideos: VideoAnalyticItem[]) {
  const now = Date.now();
  return Array.from({ length: 8 }, (_, i) => {
    const weekStart = now - (7 - i) * 7 * 24 * 60 * 60 * 1000;
    const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;
    const label = new Date(weekStart).toLocaleDateString('en', { month: 'short', day: 'numeric' });
    const week = allVideos.filter(v => {
      const ts = new Date(v.publishedAt).getTime();
      return ts >= weekStart && ts < weekEnd;
    });
    return {
      date: label,
      views: week.reduce((s, v) => s + v.views, 0),
      likes: week.reduce((s, v) => s + v.likes, 0),
      shares: week.reduce((s, v) => s + v.shares, 0),
    };
  });
}

export async function fetchDashboardAnalytics(userId: string): Promise<DashboardAnalytics> {
  const [tiktok, instagram, youtube] = await Promise.all([
    fetchTikTokAnalytics(userId),
    fetchInstagramAnalytics(userId),
    fetchYouTubeAnalytics(userId),
  ]);

  const platforms = [tiktok, instagram, youtube];
  const allVideos = platforms.flatMap(p => p.videos);

  const topVideos = [...allVideos]
    .sort((a, b) => (b.views + b.likes * 5) - (a.views + a.likes * 5))
    .slice(0, 10);

  return {
    platforms,
    totalViews: platforms.reduce((s, p) => s + p.totalViews, 0),
    totalLikes: platforms.reduce((s, p) => s + p.totalLikes, 0),
    totalShares: platforms.reduce((s, p) => s + p.totalShares, 0),
    topVideos,
    chartData: buildChartData(allVideos),
  };
}
