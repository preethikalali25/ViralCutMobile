export type Platform = 'tiktok' | 'reels' | 'youtube';
export type VideoStatus = 'processing' | 'uploading' | 'ready' | 'scheduled' | 'published';
export type HookType = 'question' | 'stat' | 'visual';

export interface Hook {
  type: HookType;
  text: string;
}

export interface VideoMetrics {
  views: number;
  likes: number;
  shares: number;
  watchTime: number;
  retention: number;
}

export interface Video {
  id: string;
  title: string;
  thumbnail: string;
  duration: number;
  status: VideoStatus;
  platforms: Platform[];
  caption?: string;
  hashtags?: string[];
  hook?: Hook;
  audio?: TrendingAudio;
  scheduledAt?: string;
  publishedAt?: string;
  metrics?: VideoMetrics;
  createdAt: string;
}

export interface TrendingAudio {
  id: string;
  title: string;
  artist: string;
  uses: string;
  trending: boolean;
}

export interface CalendarEvent {
  id: string;
  date: string;
  videoId: string;
  platform: Platform;
}

export interface AnalyticsPoint {
  date: string;
  views: number;
  likes: number;
  shares: number;
}

export interface PlatformStat {
  platform: Platform;
  posts: number;
  views: number;
  avgRetention: number;
}
