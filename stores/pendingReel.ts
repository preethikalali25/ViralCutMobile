export type PendingReelItem = {
  uri: string;
  type: 'photo' | 'video';
  previewUri: string;
  durationSec?: number;
};

let pendingItems: PendingReelItem[] | null = null;

export function setPendingReelItems(items: PendingReelItem[]): void {
  pendingItems = items;
}

export function consumePendingReelItems(): PendingReelItem[] | null {
  const items = pendingItems;
  pendingItems = null;
  return items;
}
