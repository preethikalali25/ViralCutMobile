export type PendingReelItem = {
  uri: string;
  type: 'photo' | 'video';
  previewUri: string;
  durationSec?: number;
};

type PendingReel = {
  items: PendingReelItem[];
  autoProcess: boolean;
  suggestedHook?: string;
  suggestedTitle?: string;
};

let pending: PendingReel | null = null;

export function setPendingReelItems(
  items: PendingReelItem[],
  autoProcess = false,
  suggestedHook?: string,
  suggestedTitle?: string,
): void {
  pending = { items, autoProcess, suggestedHook, suggestedTitle };
}

export function consumePendingReelItems(): PendingReel | null {
  const p = pending;
  pending = null;
  return p;
}
