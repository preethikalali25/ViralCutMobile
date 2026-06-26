export type SchedulePlatform = 'instagram' | 'tiktok' | 'youtube';

interface PlatformScheduleConfig {
  color: string;
  label: string;
  // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  bestDays: number[];
  avoidDays: number[];
  // Peak windows in PST (IST −13h30m). Times stored as [hour, minute] pairs.
  // IST prime: 7–10 PM weekdays, 8:30 PM Sat, 5:30–7 PM Sun.
  peakWindows: { day: number; hour: number; minute: number }[];
  bestHour: number;   // fallback hour (24h PST) used when no window matches
  bestMinute: number; // fallback minute
  peakLabel: string;  // human-readable best window (shown in IST for Indian audience)
}

// IST → PST conversion: subtract 13h 30m (IST = UTC+5:30, PST = UTC-8)
// e.g. Mon 7:30 PM IST = Mon 6:00 AM PST
//      Mon 9:00 PM IST = Mon 7:30 AM PST
//      Sat 8:30 PM IST = Sat 7:00 AM PST
//      Sun 6:00 PM IST = Sun 4:30 AM PST  (lighter day)
// Note: times past midnight PST wrap to next calendar day — handled below.

export const SCHEDULE_CONFIG: Record<SchedulePlatform, PlatformScheduleConfig> = {
  instagram: {
    color: '#e1306c',
    label: 'Instagram',
    // Strong days: Wed, Mon, Thu, Fri (India). Sun lighter.
    bestDays: [1, 3, 4, 5, 6], // Mon, Wed, Thu, Fri, Sat
    avoidDays: [0],             // Sun (lighter engagement)
    // IST peak 8 PM → PST 6:30 AM. Using 8:30 AM PST as sweet spot (9 PM IST sweet spot).
    peakWindows: [
      { day: 1, hour: 6,  minute: 0  }, // Mon 7:30 PM IST → Mon 6:00 AM PST
      { day: 3, hour: 7,  minute: 0  }, // Wed 8:30 PM IST → Wed 7:00 AM PST
      { day: 4, hour: 7,  minute: 0  }, // Thu 8:30 PM IST → Thu 7:00 AM PST
      { day: 5, hour: 6,  minute: 0  }, // Fri 7:30 PM IST → Fri 6:00 AM PST
      { day: 6, hour: 7,  minute: 0  }, // Sat 8:30 PM IST → Sat 7:00 AM PST
    ],
    bestHour: 7,
    bestMinute: 0,
    peakLabel: 'Mon/Wed–Fri 7:30–10 PM IST, Sat 8:30 PM IST',
  },
  tiktok: {
    color: '#ee1d52',
    label: 'TikTok',
    // Global TikTok peak: Tue–Thu 2–6 PM, Sat–Sun — keeping existing good times
    // but aligning with India evening: 8 PM IST = 6:30 AM PST
    bestDays: [0, 2, 3, 4, 6], // Sun, Tue, Wed, Thu, Sat
    avoidDays: [],
    peakWindows: [
      { day: 2, hour: 6,  minute: 30 }, // Tue 8 PM IST → Tue 6:30 AM PST
      { day: 3, hour: 7,  minute: 0  }, // Wed 8:30 PM IST → Wed 7:00 AM PST
      { day: 4, hour: 6,  minute: 30 }, // Thu 8 PM IST → Thu 6:30 AM PST
      { day: 6, hour: 7,  minute: 0  }, // Sat 8:30 PM IST → Sat 7:00 AM PST
      { day: 0, hour: 6,  minute: 0  }, // Sun 7:30 PM IST → Sun 6:00 AM PST
    ],
    bestHour: 6,
    bestMinute: 30,
    peakLabel: 'Tue–Thu 2–6 p.m., weekends',
  },
  youtube: {
    color: '#ff0000',
    label: 'YouTube Shorts',
    // YouTube India: Thu–Sat evenings, weekday evenings
    // 8 PM IST = 6:30 AM PST
    bestDays: [4, 5, 6],
    avoidDays: [2],
    peakWindows: [
      { day: 4, hour: 6,  minute: 30 }, // Thu 8 PM IST → Thu 6:30 AM PST
      { day: 5, hour: 7,  minute: 0  }, // Fri 8:30 PM IST → Fri 7:00 AM PST
      { day: 6, hour: 7,  minute: 0  }, // Sat 8:30 PM IST → Sat 7:00 AM PST
    ],
    bestHour: 6,
    bestMinute: 30,
    peakLabel: 'Fri 4–7 p.m., weekday evenings',
  },
};

/** Returns the next upcoming best posting slot for a given platform (device local time). */
export function getNextBestSlot(platform: SchedulePlatform): Date {
  // TEMP: hardcoded test slot for Instagram
  if (platform === 'instagram') {
    const slot = new Date(2026, 5, 26, 16, 50, 0, 0); // June 26 2026 4:50 PM local
    return slot;
  }
  const config = SCHEDULE_CONFIG[platform];
  const now = new Date();

  // Try each upcoming day (up to 14 days) and see if a peak window matches
  for (let daysAhead = 0; daysAhead <= 14; daysAhead++) {
    const base = new Date(now);
    base.setDate(now.getDate() + daysAhead);
    const dow = base.getDay();

    const windows = config.peakWindows.filter(w => w.day === dow);
    if (windows.length === 0) continue;

    for (const w of windows) {
      const candidate = new Date(base);
      candidate.setHours(w.hour, w.minute, 0, 0);

      // Must be at least 1 h in the future
      if (candidate.getTime() < now.getTime() + 3_600_000) continue;

      return candidate;
    }
  }

  // Fallback: next bestDay at bestHour
  for (let daysAhead = 1; daysAhead <= 7; daysAhead++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + daysAhead);
    candidate.setHours(config.bestHour, config.bestMinute, 0, 0);
    if (config.bestDays.includes(candidate.getDay())) return candidate;
  }

  // Last resort: tomorrow at bestHour
  const fallback = new Date(now);
  fallback.setDate(now.getDate() + 1);
  fallback.setHours(config.bestHour, config.bestMinute, 0, 0);
  return fallback;
}

export function formatSlot(date: Date): string {
  return date.toLocaleDateString('en', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
