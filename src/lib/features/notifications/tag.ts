export function roomTag(userId: string | undefined, roomId: string): string {
  return `${userId ?? ''} ${roomId}`;
}
