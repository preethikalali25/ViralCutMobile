export type PendingReelItem = {
  uri: string;
  type: 'photo' | 'video';
  previewUri?: string;
  durationSec?: number;
};

export type PendingReelMeta = {
  title?: string;
  hook?: string;
};

let pendingItems: PendingReelItem[] = [];
let pendingMeta: PendingReelMeta = {};
let autoOpen = false;

export function setPendingReelItems(items: PendingReelItem[], shouldAutoOpen = false, meta: PendingReelMeta = {}): void {
  pendingItems = items;
  autoOpen = shouldAutoOpen;
  pendingMeta = meta;
}

export function getPendingReelItems(): PendingReelItem[] {
  return pendingItems;
}

export function consumePendingReelItems(): { items: PendingReelItem[]; autoOpen: boolean; meta: PendingReelMeta } {
  const items = pendingItems;
  const open = autoOpen;
  const meta = pendingMeta;
  pendingItems = [];
  autoOpen = false;
  pendingMeta = {};
  return { items, autoOpen: open, meta };
}

export function hasPendingReelItems(): boolean {
  return pendingItems.length > 0;
}

export function clearPendingReelItems(): void {
  pendingItems = [];
  autoOpen = false;
  pendingMeta = {};
}
