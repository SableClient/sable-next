import type { CoreClient } from '#lib/core/client.svelte.js';
import { sendMessage } from '#lib/core/api/messages.svelte.js';
import type {
  NativeNotificationAction,
  NativeNotificationTarget,
} from '#lib/platform/native-notifications.js';

const REPLY_ACTION = 'sable-reply';
const MARK_READ_ACTION = 'sable-mark-read';
const ANSWER_CALL_ACTION = 'sable-call-answer';
const DECLINE_CALL_ACTION = 'sable-call-decline';
const ACCEPT_INVITE_ACTION = 'sable-invite-accept';
const DECLINE_INVITE_ACTION = 'sable-invite-decline';

export function callNotificationAction(
  action: NativeNotificationAction
): 'answer' | 'decline' | null {
  if (action.actionId === ANSWER_CALL_ACTION) return 'answer';
  if (action.actionId === DECLINE_CALL_ACTION) return 'decline';
  return null;
}

export function inviteNotificationAction(
  action: NativeNotificationAction
): 'accept' | 'decline' | null {
  if (action.actionId === ACCEPT_INVITE_ACTION) return 'accept';
  if (action.actionId === DECLINE_INVITE_ACTION) return 'decline';
  return null;
}

type AccountSwitcher = Pick<CoreClient, 'session' | 'accounts' | 'switchAccount'>;
type Replier = AccountSwitcher & Pick<CoreClient, 'rpc'>;

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

export type NotificationOpening = 'opened' | 'unknown_account' | 'switch_failed';

export async function openNativeNotification(
  core: AccountSwitcher,
  target: NativeNotificationTarget,
  open: (roomId: string, eventId: string | null) => void | Promise<void>
): Promise<NotificationOpening> {
  let selected: boolean;
  try {
    selected = await selectNotificationAccount(core, target.userId);
  } catch (error) {
    console.warn('[sable notifications] account not switched', error);
    return 'switch_failed';
  }
  if (!selected) return 'unknown_account';
  await open(target.roomId, target.eventId);
  return 'opened';
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
    await sendMessage(core.rpc, action.roomId, action.text);
  }

  if (action.eventId !== null) {
    await core.rpc.timeline.markRead({
      room_id: action.roomId,
      event_id: action.eventId,
      private_receipt: readReceiptIsPrivate,
      thread_root: null,
      subscription: null,
      fully_read: true,
    });
  }
}
