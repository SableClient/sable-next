import type { Page } from '@playwright/test';

type WorkerMode =
  | 'ready'
  | 'loading'
  | 'error'
  | 'delayed_history'
  | 'delayed_snapshot'
  | 'delayed_layout_diff';

declare global {
  interface Window {
    __e2eCommands: string[];
    __e2eTimelineRooms: string[];
    __e2eTimelineSubscriptions: number[];
    __e2eEmitTimelineEvent: (event: unknown) => void;
  }
}

export async function installFakeCore(page: Page, mode: WorkerMode): Promise<void> {
  await page.addInitScript((workerMode: WorkerMode) => {
    const commandLog: string[] = [];
    const timelineRooms: string[] = [];
    const timelineSubscriptions: number[] = [];
    Object.defineProperty(window, '__e2eCommands', {
      configurable: true,
      value: commandLog,
    });
    Object.defineProperty(window, '__e2eTimelineRooms', {
      configurable: true,
      value: timelineRooms,
    });
    Object.defineProperty(window, '__e2eTimelineSubscriptions', {
      configurable: true,
      value: timelineSubscriptions,
    });
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
    const secondRoom = { ...room, room_id: '!second:example.test', name: 'Random' };
    const timelineItems = (roomName: string) =>
      Array.from({ length: 20 }, (_, index) => ({
        id: `${roomName.toLowerCase()}-${String(index)}`,
        event_id: `$${roomName.toLowerCase()}-${String(index)}:example.test`,
        transaction_id: null,
        send_state: null,
        sender: '@alice:example.test',
        sender_name: 'Alice',
        sender_avatar: null,
        timestamp: 1_700_000_000_000 + index,
        content: {
          kind: 'message',
          body: index === 0 ? `Welcome to ${roomName}` : `${roomName} message ${String(index)}`,
          formatted: null,
          edited: false,
        },
        in_reply_to: null,
        thread_root: null,
        thread_summary: null,
        reactions: [],
        is_own: false,
        read_by: [],
      }));
    const rooms = new Map([
      [room.room_id, room],
      [secondRoom.room_id, secondRoom],
    ]);
    let nextSubscription = 2;
    const subscriptions = new Map<number, { roomId: string; page: number }>();
    let activePort: FakePort | null = null;

    class FakePort {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onmessageerror: ((event: MessageEvent) => void) | null = null;

      start(): void {}

      close(): void {}

      emit(event: unknown): void {
        this.onmessage?.({ data: { event } } as MessageEvent);
      }

      postMessage(request: { id: number; command?: { type: string } }): void {
        const command = request.command?.type;
        if (command) commandLog.push(command);
        if (command === 'subscribe_timeline') {
          const roomId = (request.command as { room_id?: string }).room_id ?? 'missing';
          const subscription = nextSubscription++;
          subscriptions.set(subscription, { roomId, page: 0 });
          timelineRooms.push(roomId);
          timelineSubscriptions.push(subscription);
        }
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
                        ? {
                            type: 'subscribe_room_list',
                            subscription: 1,
                            rooms: [room, secondRoom],
                          }
                        : command === 'subscribe_timeline'
                          ? (() => {
                              const subscription = timelineSubscriptions.at(-1);
                              if (subscription === undefined)
                                throw new Error('missing timeline subscription');
                              const state = subscriptions.get(subscription);
                              if (!state) throw new Error('unknown timeline subscription');
                              const room = rooms.get(state.roomId);
                              if (!room) throw new Error('unknown timeline room');
                              const items = timelineItems(room.name);
                              return {
                                type: 'subscribe_timeline',
                                subscription,
                                items:
                                  workerMode === 'delayed_snapshot'
                                    ? items.slice(-1)
                                    : workerMode === 'delayed_history'
                                      ? items.map((item, index) => ({
                                          ...item,
                                          content: {
                                            ...item.content,
                                            body: `Delayed history ${String(index)}`,
                                          },
                                        }))
                                      : items,
                              };
                            })()
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
                                  ? (() => {
                                      const { subscription, direction } =
                                        request.command as unknown as {
                                          subscription: number;
                                          direction?: unknown;
                                        };
                                      if (direction !== 'backward' && direction !== 'forward') {
                                        throw new Error('missing pagination direction');
                                      }
                                      const state = subscriptions.get(subscription);
                                      if (!state) throw new Error('unknown timeline subscription');
                                      const room = rooms.get(state.roomId);
                                      if (!room) throw new Error('unknown timeline room');
                                      state.page += 1;
                                      const reachedEnd = state.page >= 2;
                                      this.emit({
                                        type: 'timeline_pagination',
                                        subscription,
                                        loading: true,
                                        reached_start: false,
                                      });
                                      window.setTimeout(
                                        () => {
                                          const items = timelineItems(room.name);
                                          this.emit({
                                            type: 'timeline_diff',
                                            subscription,
                                            diffs:
                                              workerMode === 'delayed_history'
                                                ? items.slice(0, -1).map((value, index) => ({
                                                    op: 'insert' as const,
                                                    index,
                                                    value: {
                                                      ...value,
                                                      content: {
                                                        ...value.content,
                                                        body: `Delayed history ${String(index)}`,
                                                      },
                                                    },
                                                  }))
                                                : [
                                                    {
                                                      op: 'push_front',
                                                      value: {
                                                        ...items[0],
                                                        id: `${room.name.toLowerCase()}-history-${String(state.page)}`,
                                                        event_id: `$${room.name.toLowerCase()}-history-${String(state.page)}`,
                                                        content: {
                                                          kind: 'message',
                                                          body: `${room.name} history ${String(state.page)}`,
                                                          formatted: null,
                                                          edited: false,
                                                        },
                                                      },
                                                    },
                                                  ],
                                          });
                                          this.emit({
                                            type: 'timeline_pagination',
                                            subscription,
                                            loading: false,
                                            reached_start: reachedEnd,
                                          });
                                        },
                                        workerMode === 'delayed_history' ? 750 : 0
                                      );
                                      return {
                                        type: 'paginate',
                                        direction,
                                        reached_end: reachedEnd,
                                      };
                                    })()
                                  : command === 'mark_read' || command === 'set_typing'
                                    ? { type: command }
                                    : command === 'unsubscribe'
                                      ? { type: 'unsubscribe' }
                                      : { type: command },
              };

        window.setTimeout(
          () => {
            this.onmessage?.({ data: response } as MessageEvent);
            if (
              command !== 'subscribe_timeline' ||
              !('ok' in response) ||
              response.ok?.type !== 'subscribe_timeline'
            )
              return;
            const subscription = timelineSubscriptions.at(-1);
            if (subscription === undefined) return;
            const state = subscriptions.get(subscription);
            const room = state && rooms.get(state.roomId);
            if (!room) return;
            this.emit({
              type: 'timeline_pagination',
              subscription,
              loading: false,
              reached_start: false,
            });
            if (workerMode === 'delayed_layout_diff') {
              window.setTimeout(() => {
                const last = timelineItems(room.name).at(-1);
                if (!last) return;
                this.emit({
                  type: 'timeline_diff',
                  subscription,
                  diffs: [
                    {
                      op: 'set',
                      index: 19,
                      value: {
                        ...last,
                        content: {
                          ...last.content,
                          body: `Delayed layout event ${'wraps '.repeat(80)}`,
                        },
                      },
                    },
                  ],
                });
              }, 750);
            }
          },
          command === 'paginate'
            ? 500
            : (workerMode === 'delayed_snapshot' || workerMode === 'delayed_history') &&
                command === 'subscribe_timeline'
              ? 750
              : 0
        );
      }
    }

    Object.defineProperty(window, '__e2eEmitTimelineEvent', {
      configurable: true,
      value: (event: unknown) => activePort?.emit(event),
    });

    class FakeSharedWorker {
      port = new FakePort();

      constructor() {
        activePort = this.port;
      }

      addEventListener(): void {}
    }

    Object.defineProperty(window, 'SharedWorker', {
      configurable: true,
      value: FakeSharedWorker,
    });
  }, mode);
}
