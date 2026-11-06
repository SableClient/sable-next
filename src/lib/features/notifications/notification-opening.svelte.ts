let pending = $state(0);

export function openingNotification(): boolean {
  return pending > 0;
}

export async function trackNotificationOpening<T>(opening: Promise<T>): Promise<T> {
  pending += 1;
  try {
    return await opening;
  } finally {
    pending -= 1;
  }
}
