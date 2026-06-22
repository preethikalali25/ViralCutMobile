export type SchedulePlatform = 'instagram' | 'tiktok' | 'youtube';

interface PlatformScheduleConfig {
  color: string;
  label: string;
  // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  bestDays: number[];
  avoidDays: number[];
  bestHour: number; // default suggested hour (24h)
  peakLabel: string; // human-readable best window
}

export const SCHEDULE_CONFIG: Record<SchedulePlatform, PlatformScheduleConfig> = {
  instagram: {
    color: '#e1306c',
    label: 'Instagram',
    bestDays: [2, 3, 4],      // Tue, Wed, Thu
    avoidDays: [5, 6],         // Fri, Sat
    bestHour: 12,
    peakLabel: 'Tue–Thu, 12–7 p.m.',
  },
  tiktok: {
    color: '#010101',
    label: 'TikTok',
    bestDays: [0, 2, 3, 4, 6], // Sun, Tue, Wed, Thu, Sat
    avoidDays: [],
    bestHour: 14,              // 2pm
    peakLabel: 'Tue–Thu 2–6 p.m., weekends',
  },
  youtube: {
    color: '#ff0000',
    label: 'YouTube Shorts',
    bestDays: [4, 5, 6],       // Thu, Fri, Sat
    avoidDays: [2],             // Tue
    bestHour: 18,              // 6pm
    peakLabel: 'Fri 4–7 p.m., weekday evenings',
  },
};

/** Returns the next upcoming best posting slot for a given platform. */
export function getNextBestSlot(platform: SchedulePlatform): Date {
  const config = SCHEDULE_CONFIG[platform];
  const now = new Date();

  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + daysAhead);
    candidate.setHours(config.bestHour, 0, 0, 0);
    candidate.setSeconds(0, 0);

    const dow = candidate.getDay();
    if (!config.bestDays.includes(dow)) continue;

    // Same-day slot must still be at least 1 h away
    if (daysAhead === 0 && candidate.getTime() < now.getTime() + 3_600_000) continue;

    return candidate;
  }

  // Fallback: tomorrow at bestHour
  const fallback = new Date(now);
  fallback.setDate(now.getDate() + 1);
  fallback.setHours(config.bestHour, 0, 0, 0);
  fallback.setSeconds(0, 0);
  return fallback;
}

export function formatSlot(date: Date): string {
  return date.toLocaleDateString('en', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
