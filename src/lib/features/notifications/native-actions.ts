import type { CoreClient } from '#lib/core/client.svelte.js';
import type {
  NativeNotificationAction,
  NativeNotificationTarget,
} from '#lib/platform/native-notifications.js';

const REPLY_ACTION = 'sable-reply';
const MARK_READ_ACTION = 'sable-mark-read';
const ANSWER_CALL_ACTION = 'sable-call-answer';
const DECLINE_CALL_ACTION = 'sable-call-decline';

export function callNotificationAction(
  action: NativeNotificationAction
): 'answer' | 'decline' | null {
  if (action.actionId === ANSWER_CALL_ACTION) return 'answer';
  if (action.actionId === DECLINE_CALL_ACTION) return 'decline';
  return null;
}

type AccountSwitcher = Pick<CoreClient, 'session' | 'accounts' | 'switchAccount'>;
type Replier = AccountSwitcher & Pick<CoreClient, 'commands'>;

export async function selectNotificationAccount(
  core: AccountSwitcher,
  userId: string
): Promise<boolean> {
  const account = core.accounts.find((entry) => entry.user_id === userId);
  if (account === undefined) return false;

  if (core.session?.account_id !== account.account_id) {
    await core.switchAccount(account.account_id);
  }
  return true;
}

export async function openNativeNotification(
  core: AccountSwitcher,
  target: NativeNotificationTarget,
  open: (roomId: string, eventId: string | null) => void | Promise<void>
): Promise<void> {
  if (!(await selectNotificationAccount(core, target.userId))) return;
  await open(target.roomId, target.eventId);
}

export async function performNotificationAction(
  core: Replier,
  action: NativeNotificationAction,
  readReceiptIsPrivate: boolean
): Promise<void> {
  if (action.actionId !== REPLY_ACTION && action.actionId !== MARK_READ_ACTION) return;
  if (action.actionId === REPLY_ACTION && action.text === null) return;

  if (!(await selectNotificationAccount(core, action.userId))) return;

  if (action.text !== null && action.actionId === REPLY_ACTION) {
    await core.commands.sendMessage(action.roomId, action.text);
  }

  if (action.eventId !== null) {
    await core.commands.markRead(action.roomId, action.eventId, readReceiptIsPrivate);
  }
}
