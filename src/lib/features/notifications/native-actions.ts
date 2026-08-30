import type { CoreClient } from '#lib/core/client.svelte.js';
import type { NativeNotificationAction } from '#lib/platform/native-notifications.js';

const REPLY_ACTION = 'sable-reply';
const MARK_READ_ACTION = 'sable-mark-read';

type Replier = Pick<CoreClient, 'session' | 'commands' | 'switchAccount'>;

export async function performNotificationAction(
  core: Replier,
  action: NativeNotificationAction,
  readReceiptIsPrivate: boolean
): Promise<void> {
  if (action.actionId !== REPLY_ACTION && action.actionId !== MARK_READ_ACTION) return;
  if (action.actionId === REPLY_ACTION && action.text === null) return;

  if (core.session?.account_id !== action.userId) await core.switchAccount(action.userId);

  if (action.text !== null && action.actionId === REPLY_ACTION) {
    await core.commands.sendMessage(action.roomId, action.text);
  }

  if (action.eventId !== null) {
    await core.commands.markRead(action.roomId, action.eventId, readReceiptIsPrivate);
  }
}
