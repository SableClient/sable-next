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
  if (core.session?.account_id !== account.account_id) {
    throw new Error('The notification account was not selected');
  }
  return true;
}

export type NotificationOpening = 'opened' | 'unknown_account' | 'switch_failed' | 'superseded';
export type NativeNotificationOpen = (
  roomId: string,
  eventId: string | null,
  isCurrent: () => boolean
) => void | Promise<void>;

export class NativeNotificationOpener {
  private generation = 0;
  private selecting: Promise<void> = Promise.resolve();

  constructor(private readonly core: AccountSwitcher) {}

  cancel(): void {
    this.generation += 1;
  }

  async open(
    target: NativeNotificationTarget,
    open: NativeNotificationOpen
  ): Promise<NotificationOpening> {
    const generation = ++this.generation;
    const selecting = this.selecting.then(async () => {
      if (generation !== this.generation) return null;
      return (await selectNotificationAccount(this.core, target.userId)) ? this.core.session : null;
    });
    this.selecting = selecting.then(
      () => undefined,
      () => undefined
    );
    let session: AccountSwitcher['session'];
    try {
      session = await selecting;
    } catch (error) {
      if (generation !== this.generation) return 'superseded';
      console.warn('[sable notifications] account not switched', error);
      return 'switch_failed';
    }
    if (generation !== this.generation) return 'superseded';
    if (session === null) return 'unknown_account';
    const isCurrent = (): boolean =>
      generation === this.generation &&
      this.core.session === session &&
      session.user_id === target.userId;
    if (!isCurrent()) return 'superseded';
    await open(target.roomId, target.eventId, isCurrent);
    return isCurrent() ? 'opened' : 'superseded';
  }
}

export async function performNotificationAction(
  core: Replier,
  action: NativeNotificationAction
): Promise<void> {
  if (action.actionId !== REPLY_ACTION && action.actionId !== MARK_READ_ACTION) return;
  if (action.actionId === REPLY_ACTION && action.text === null) return;

  if (!(await selectNotificationAccount(core, action.userId))) return;
  const session = core.session;
  if (session?.user_id !== action.userId) return;

  if (action.text !== null && action.actionId === REPLY_ACTION) {
    await sendMessage(core.rpc, action.roomId, action.text);
  }

  if (action.eventId !== null) {
    if (core.session !== session) return;
    await core.rpc.timeline.markRead({
      room_id: action.roomId,
      event_id: action.eventId,
      thread_root: null,
      subscription: null,
      fully_read: true,
    });
  }
}
