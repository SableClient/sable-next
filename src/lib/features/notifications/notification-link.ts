import { resolve } from '$app/paths';

export function notificationPermalink(
  roomId: string,
  eventId: string | null | undefined,
  userId: string | null | undefined
): string {
  const path = resolve('/(app)/to/[...permalink]', { permalink: encodeURIComponent(roomId) });
  const query = new URLSearchParams();
  if (eventId) query.set('notified', eventId);
  if (userId) query.set('user', userId);
  const search = query.toString();
  return search === '' ? path : `${path}?${search}`;
}
