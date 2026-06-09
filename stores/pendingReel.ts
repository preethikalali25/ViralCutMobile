export type PendingReelItem = {
  uri: string;
  type: 'photo' | 'video';
  previewUri: string;
  durationSec?: number;
};

type PendingReel = {
  items: PendingReelItem[];
  autoProcess: boolean;
};

let pending: PendingReel | null = null;

export function setPendingReelItems(items: PendingReelItem[], autoProcess = false): void {
  pending = { items, autoProcess };
}

export function consumePendingReelItems(): PendingReel | null {
  const p = pending;
  pending = null;
  return p;
}
