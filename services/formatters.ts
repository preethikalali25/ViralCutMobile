export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function getRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function getPlatformLabel(platform: string): string {
  const labels: Record<string, string> = {
    tiktok: 'TikTok',
    reels: 'Reels',
    youtube: 'YT Shorts',
  };
  return labels[platform] || platform;
}

export function getStatusColor(status: string): string {
  const map: Record<string, string> = {
    published: '#10b981',
    scheduled: '#f59e0b',
    ready: '#06b6d4',
    processing: '#a855f7',
    uploading: '#a855f7',
  };
  return map[status] || '#8892b0';
}

export function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    published: 'Published',
    scheduled: 'Scheduled',
    ready: 'Ready',
    processing: 'Processing',
    uploading: 'Uploading',
  };
  return map[status] || status;
}
