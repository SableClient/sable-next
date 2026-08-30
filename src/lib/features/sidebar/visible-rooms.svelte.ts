let order = $state.raw<readonly string[]>([]);

export function publishVisibleRoomOrder(roomIds: readonly string[]): void {
  order = roomIds;
}

export function visibleRoomOrder(): readonly string[] {
  return order;
}

export function roomAtOffset(currentRoomId: string | null, offset: number): string | null {
  if (order.length === 0) return null;

  const index = currentRoomId === null ? -1 : order.indexOf(currentRoomId);
  if (index === -1) return offset > 0 ? order[0] : order[order.length - 1];

  return order[(index + offset + order.length) % order.length];
}
