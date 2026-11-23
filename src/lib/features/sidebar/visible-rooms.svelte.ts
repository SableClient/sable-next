let order = $state.raw<readonly string[]>([]);
let shownSection: string | null = null;

export function publishVisibleRoomOrder(roomIds: readonly string[], section: string | null): void {
  order = roomIds;
  shownSection = section;
}

export function visibleRoomOrder(): readonly string[] {
  return order;
}

/** The section the room list shows, which it keeps on pages such as Inbox or Search. */
export function visibleRoomSection(): string | null {
  return shownSection;
}

export function roomAtOffset(currentRoomId: string | null, offset: number): string | null {
  if (order.length === 0) return null;

  const index = currentRoomId === null ? -1 : order.indexOf(currentRoomId);
  if (index === -1) return offset > 0 ? order[0] : order[order.length - 1];

  return order[(index + offset + order.length) % order.length];
}
