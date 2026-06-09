/**
 * Simple in-memory store for pending reel items selected from the Suggest screen.
 * The upload screen reads this to pre-populate the video picker with chosen gallery items.
 */

export type PendingReelItem = {
  uri: string;
  type: 'photo' | 'video';
  previewUri?: string;
  durationSec?: number;
};

let pendingItems: PendingReelItem[] = [];
let autoOpen = false;

export function setPendingReelItems(items: PendingReelItem[], shouldAutoOpen = false): void {
  pendingItems = items;
  autoOpen = shouldAutoOpen;
}

export function getPendingReelItems(): PendingReelItem[] {
  return pendingItems;
}

export function consumePendingReelItems(): { items: PendingReelItem[]; autoOpen: boolean } {
  const items = pendingItems;
  const open = autoOpen;
  pendingItems = [];
  autoOpen = false;
  return { items, open };
}

export function hasPendingReelItems(): boolean {
  return pendingItems.length > 0;
}

export function clearPendingReelItems(): void {
  pendingItems = [];
  autoOpen = false;
}
