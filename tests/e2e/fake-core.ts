import type { Page } from '@playwright/test';

type WorkerMode = 'ready' | 'loading' | 'error';

export async function installFakeCore(page: Page, mode: WorkerMode): Promise<void> {
  await page.addInitScript((workerMode: WorkerMode) => {
    const session = {
      account_id: 'e2e-account',
      user_id: '@e2e:example.test',
      device_id: 'E2EDEVICE',
    };
    const room = {
      room_id: '!room:example.test',
      canonical_alias: null,
      name: 'General',
      avatar_url: null,
      is_direct: false,
      state: 'joined',
      encrypted: true,
      is_space: false,
      space_parents: [],
      space_children: [],
      unread: 2,
      highlight: 1,
      latest_event: null,
    };
    const timelineItem = {
      id: 'event-1',
      event_id: '$event:example.test',
      transaction_id: null,
      send_state: null,
      sender: '@alice:example.test',
      sender_name: 'Alice',
      sender_avatar: null,
      timestamp: 1_700_000_000_000,
      content: { kind: 'message', body: 'Welcome to General', formatted: null, edited: false },
      in_reply_to: null,
      thread_root: null,
      thread_summary: null,
      reactions: [],
      is_own: false,
      read_by: [],
    };

    class FakePort {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onmessageerror: ((event: MessageEvent) => void) | null = null;

      start(): void {}

      close(): void {}

      postMessage(request: { id: number; command?: { type: string } }): void {
        const command = request.command?.type;
        if (workerMode === 'loading' && command === 'restore') return;

        const response =
          workerMode === 'error' && command === 'restore'
            ? { id: request.id, err: { code: 'unavailable' } }
            : {
                id: request.id,
                ok:
                  command === 'restore'
                    ? { type: 'restore', session }
                    : command === 'list_accounts'
                      ? { type: 'list_accounts', accounts: [session] }
                      : command === 'subscribe_room_list'
                        ? { type: 'subscribe_room_list', subscription: 1, rooms: [room] }
                        : command === 'subscribe_timeline'
                          ? { type: 'subscribe_timeline', subscription: 2, items: [timelineItem] }
                          : command === 'room_members'
                            ? {
                                type: 'room_members',
                                members: [
                                  {
                                    user_id: '@alice:example.test',
                                    display_name: 'Alice',
                                    avatar_url: null,
                                    power_level: 100,
                                  },
                                ],
                              }
                            : command === 'encryption_status'
                              ? {
                                  type: 'encryption_status',
                                  status: {
                                    verification: 'verified',
                                    recovery: 'enabled',
                                    cross_signing_ready: true,
                                  },
                                }
                              : command === 'devices'
                                ? {
                                    type: 'devices',
                                    devices: [
                                      {
                                        device_id: 'E2EDEVICE',
                                        display_name: 'This browser',
                                        is_verified: true,
                                        is_own: true,
                                      },
                                      {
                                        device_id: 'PHONE',
                                        display_name: 'Phone',
                                        is_verified: false,
                                        is_own: false,
                                      },
                                    ],
                                  }
                                : command === 'paginate'
                                  ? { type: 'paginate', reached_start: true }
                                  : command === 'mark_read' || command === 'set_typing'
                                    ? { type: command }
                                    : command === 'unsubscribe'
                                      ? { type: 'unsubscribe' }
                                      : { type: command },
              };

        window.setTimeout(() => {
          this.onmessage?.({ data: response } as MessageEvent);
        }, 0);
      }
    }

    class FakeSharedWorker {
      port = new FakePort();

      addEventListener(): void {}
    }

    Object.defineProperty(window, 'SharedWorker', {
      configurable: true,
      value: FakeSharedWorker,
    });
  }, mode);
}
