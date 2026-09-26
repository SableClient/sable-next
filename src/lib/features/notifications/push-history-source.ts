import { clearNativePushHistory, nativePushHistory } from '#lib/platform/native-notifications.js';

import { type PushHistoryEntry, readPushHistory } from './push-history';
import { clearPushHistory, pushHistory } from './room-names';

export async function loadPushHistory(): Promise<PushHistoryEntry[]> {
  const native = await nativePushHistory();
  const entries = native === null ? await pushHistory() : readPushHistory(native);
  return [...entries].reverse();
}

export async function forgetPushHistory(): Promise<void> {
  await Promise.all([clearNativePushHistory(), clearPushHistory()]);
}
