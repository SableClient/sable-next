import type { Page } from '@playwright/test';

export type RoomCoreMode =
  | 'ready'
  | 'loading'
  | 'error'
  | 'delayed_history'
  | 'unread'
  | 'delayed_media'
  | 'delayed_pagination'
  | 'endless_history'
  | 'delayed_snapshot'
  | 'empty_room'
  | 'delayed_layout_diff'
  | 'spaces';

type WorkerMode = RoomCoreMode;

declare global {
  interface Window {
    __e2eCommands: string[];
    __e2eAnchorPositions: number[];
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
    const profile = {
      user_id: session.user_id,
      display_name: 'E2E User',
      avatar_url: null,
      bio: null,
      hero_color: null,
      hero_brightness: null,
      banner_url: null,
      status: null,
      pronouns: [],
      timezone: null,
      name_color_light: null,
      name_color_dark: null,
      animal: null,
      extra: [],
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
      is_voice: false,
      call_participants: [] as string[],
      space_children: [],
      unread: 2,
      highlight: 1,
      latest_event: {
        sender: '@alice:example.test',
        body: 'General message 19',
        timestamp: 1_700_000_000_019,
        sending: false,
        event_id: '$general-19:example.test' as string | null,
      },
    };
    const secondRoom = { ...room, room_id: '!second:example.test', name: 'Random' };
    const invitedRoom = {
      ...room,
      room_id: '!invited:example.test',
      name: 'Design crew',
      topic: 'Where the redesign happens.',
      state: 'invited',
      unread: 0,
      highlight: 0,
      latest_event: {
        sender: '@ada:example.test',
        body: 'invited you',
        timestamp: 1_700_000_000_000,
        sending: false,
        event_id: null,
      },
    };
    const alphaSpace = {
      ...room,
      room_id: '!alpha:example.test',
      name: 'Alpha',
      is_space: true,
      encrypted: false,
      unread: 0,
      highlight: 0,
      latest_event: null,
    };
    const betaSpace = { ...alphaSpace, room_id: '!beta:example.test', name: 'Beta' };
    const gammaSpace = { ...alphaSpace, room_id: '!gamma:example.test', name: 'Gamma' };
    const joinedRooms =
      workerMode === 'spaces'
        ? [room, secondRoom, invitedRoom, alphaSpace, betaSpace, gammaSpace]
        : [room, secondRoom, invitedRoom];
    const hierarchyRoom = (
      roomId: string,
      name: string,
      overrides: Record<string, unknown> = {}
    ) => ({
      room_id: roomId,
      canonical_alias: null,
      name,
      topic: null,
      avatar_url: null,
      is_space: false,
      is_voice: false,
      num_joined_members: 3,
      join_rule: 'public',
      guest_can_join: false,
      children: [],
      ...overrides,
    });

    const childEdge = (roomId: string, position: number, order: string | null = null) => ({
      room_id: roomId,
      order,
      origin_server_ts: position,
      suggested: false,
    });

    const hierarchyPages: Record<string, { rooms: unknown[]; next_batch: string | null }> = {
      '': {
        rooms: [
          hierarchyRoom('!alpha:example.test', 'Alpha', {
            is_space: true,
            children: [
              childEdge('!nested:example.test', 1, 'a'),
              childEdge('!late:example.test', 2, 'b'),
              childEdge('!middle:example.test', 3, 'c'),
              childEdge('!tail:example.test', 4, 'd'),
            ],
          }),
          hierarchyRoom('!nested:example.test', 'Nested', {
            is_space: true,
            children: [childEdge('!deep:example.test', 1)],
          }),
        ],
        next_batch: 'page-two',
      },
      'page-two': {
        rooms: [
          hierarchyRoom('!late:example.test', 'Late Arrival'),
          hierarchyRoom('!middle:example.test', 'Middle Room'),
          hierarchyRoom('!tail:example.test', 'Tail Room'),
          hierarchyRoom('!deep:example.test', 'Deep Room'),
        ],
        next_batch: null,
      },
    };

    const CHILD_ORDER_KEY = 'e2e-space-child-order';
    const recordChildOrder = (command: Record<string, unknown>): void => {
      const stored: unknown = JSON.parse(sessionStorage.getItem(CHILD_ORDER_KEY) ?? '[]');
      const log = Array.isArray(stored) ? stored : [];
      log.push({
        space_id: command['space_id'],
        room_id: command['room_id'],
        order: command['order'],
      });
      sessionStorage.setItem(CHILD_ORDER_KEY, JSON.stringify(log));
    };

    const hierarchyPage = (from: string) => {
      const page = hierarchyPages[from] ?? { rooms: [], next_batch: null };
      return { type: 'space_hierarchy', rooms: page.rooms, next_batch: page.next_batch };
    };

    const SIDEBAR_KEY = 'e2e-space-sidebar';
    const readSidebar = (): unknown[] => {
      try {
        const stored: unknown = JSON.parse(sessionStorage.getItem(SIDEBAR_KEY) ?? '[]');
        return Array.isArray(stored) ? stored : [];
      } catch {
        return [];
      }
    };
    const searchHits = (payload: Record<string, unknown>) => {
      const query = (typeof payload.query === 'string' ? payload.query : '').toLowerCase();
      const filter = (payload.filter ?? {}) as {
        rooms?: string[];
        senders?: string[];
        phrases?: string[];
        not_rooms?: string[];
        not_senders?: string[];
        exclude?: string[];
      };
      const offset = Number(payload.offset ?? 0);
      const newestFirst = payload.order === 'recent';

      return [room, secondRoom]
        .filter(
          (candidate) =>
            (!filter.rooms?.length || filter.rooms.includes(candidate.room_id)) &&
            !filter.not_rooms?.includes(candidate.room_id)
        )
        .flatMap((candidate) =>
          timelineItems(candidate.name)
            .filter((item) => {
              const body = item.content.body.toLowerCase();
              if (query !== '' && !query.split(/\s+/).every((word) => body.includes(word)))
                return false;
              if (filter.senders?.length && !filter.senders.includes(item.sender)) return false;
              if (filter.not_senders?.includes(item.sender)) return false;
              if ((filter.exclude ?? []).some((term) => body.includes(term.toLowerCase())))
                return false;
              return (filter.phrases ?? []).every((phrase) => body.includes(phrase.toLowerCase()));
            })
            .map((item) => ({
              room_id: candidate.room_id,
              event_id: item.event_id,
              body: item.content.body,
              sender: item.sender,
              origin_server_ts: item.timestamp,
              score: 1,
            }))
        )
        .sort((left, right) => (newestFirst ? right.origin_server_ts - left.origin_server_ts : 0))
        .slice(offset, offset + Number(payload.limit ?? 30));
    };

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
          html: index === 0 ? `Welcome to ${roomName}` : `${roomName} message ${String(index)}`,
          emote: false,
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
      [invitedRoom.room_id, invitedRoom],
    ]);
    let nextSubscription = 2;
    const subscriptions = new Map<number, { roomId: string; page: number }>();
    let activePort: FakePort | null = null;
    /* Encoded, not a hand-written byte literal: those are easy to get wrong and an
       undecodable one measures nothing. A `wide-` source serves a file that
       disagrees with the box the row was reserved at. */
    const servedBytes = new Map<string, Promise<Uint8Array>>();
    function servedPng(source: string): Promise<Uint8Array> {
      const [width, height] = source.includes('wide-') ? [1000, 400] : [80, 60];
      const key = `${String(width)}x${String(height)}`;
      let bytes = servedBytes.get(key);
      if (bytes === undefined) {
        const canvas = new OffscreenCanvas(width, height);
        // convertToBlob throws on a canvas that has never had a context.
        canvas.getContext('2d')?.clearRect(0, 0, width, height);
        bytes = canvas
          .convertToBlob({ type: 'image/png' })
          .then((blob) => blob.arrayBuffer())
          .then((buffer) => new Uint8Array(buffer));
        servedBytes.set(key, bytes);
      }
      return bytes;
    }

    class FakePort {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onmessageerror: ((event: MessageEvent) => void) | null = null;

      start(): void {}

      close(): void {}

      emit(event: unknown): void {
        this.onmessage?.({ data: { event } } as MessageEvent);
      }

      postMessage(request: {
        id: number;
        command?: { type: string };
        media?: { source: string };
      }): void {
        if (request.media) {
          const { source } = request.media;
          window.setTimeout(
            () => {
              void servedPng(source).then((bytes) => {
                this.onmessage?.({ data: { id: request.id, bytes } } as MessageEvent);
              });
            },
            workerMode === 'delayed_media' ? 1_000 : 100
          );
          return;
        }
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
        if (command === 'user_profile') {
          const requested = (request.command as { user_id?: string }).user_id ?? profile.user_id;
          const localpart = requested.replace(/^@/, '').split(':')[0];
          const named = {
            ...profile,
            user_id: requested,
            display_name:
              requested === profile.user_id
                ? profile.display_name
                : `${localpart.charAt(0).toUpperCase()}${localpart.slice(1)}`,
          };
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, profile: named } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'set_space_child_order') {
          recordChildOrder(request.command as unknown as Record<string, unknown>);
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'room_permissions') {
          const roomId = (request.command as { room_id?: string }).room_id ?? '';
          const canPost = roomId !== '!second:example.test';
          window.setTimeout(() => {
            this.onmessage?.({
              data: {
                id: request.id,
                ok: {
                  type: command,
                  own_power_level: canPost ? 100 : 0,
                  can_post: canPost,
                  can_redact_others: canPost,
                  can_invite: canPost,
                  can_kick: canPost,
                  can_ban: canPost,
                  can_change_settings: canPost,
                  can_change_join_rule: canPost,
                  can_change_power_levels: canPost,
                  can_manage_children: canPost,
                },
              },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'space_sidebar') {
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, items: readSidebar() } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'set_space_sidebar') {
          const items = (request.command as { items?: unknown[] }).items ?? [];
          sessionStorage.setItem(SIDEBAR_KEY, JSON.stringify(items));
          window.setTimeout(() => {
            this.onmessage?.({ data: { id: request.id, ok: { type: command } } } as MessageEvent);

            this.emit({ type: 'space_sidebar_changed', items });
          });
          return;
        }
        if (command === 'account_contacts' || command === 'ignored_users') {
          const ok =
            command === 'account_contacts'
              ? { type: command, emails: [] }
              : { type: command, users: [] };
          window.setTimeout(() => {
            this.onmessage?.({ data: { id: request.id, ok } } as MessageEvent);
          });
          return;
        }

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
                            rooms: joinedRooms,
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
                              const timelineStart = {
                                ...items[0],
                                id: `${room.name.toLowerCase()}-date-divider`,
                                event_id: null,
                                sender: null,
                                sender_name: null,
                                timestamp: 1_700_000_000_000,
                                content: {
                                  kind: 'date_divider' as const,
                                  timestamp: 1_700_000_000_000,
                                },
                              };
                              const readMarker = {
                                ...items[0],
                                id: `${room.name.toLowerCase()}-read-marker`,
                                event_id: null,
                                sender: null,
                                sender_name: null,
                                content: { kind: 'read_marker' as const },
                              };
                              return {
                                type: 'subscribe_timeline',
                                subscription,
                                items:
                                  workerMode === 'empty_room'
                                    ? []
                                    : workerMode === 'delayed_snapshot'
                                      ? items.slice(-1)
                                      : workerMode === 'delayed_history'
                                        ? items.map((item, index) => ({
                                            ...item,
                                            content: {
                                              ...item.content,
                                              body: `Delayed history ${String(index)}`,
                                              html: `Delayed history ${String(index)}`,
                                            },
                                          }))
                                        : workerMode === 'delayed_pagination'
                                          ? [timelineStart, ...items]
                                          : workerMode === 'unread'
                                            ? [...items.slice(0, 5), readMarker, ...items.slice(5)]
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
                                      const reachedEnd =
                                        workerMode === 'endless_history'
                                          ? false
                                          : workerMode === 'empty_room' ||
                                            workerMode === 'delayed_history' ||
                                            state.page >= 2;
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
                                              workerMode === 'empty_room'
                                                ? []
                                                : workerMode === 'endless_history'
                                                  ? Array.from({ length: 20 }, (_, index) => ({
                                                      op: 'insert' as const,
                                                      index: index + 1,
                                                      value: {
                                                        ...items[0],
                                                        id: `endless-${String(state.page)}-${String(index)}`,
                                                        event_id: `$endless-${String(state.page)}-${String(index)}:example.test`,
                                                        timestamp:
                                                          1_600_000_000_000 +
                                                          state.page * 100 +
                                                          index,
                                                        content: {
                                                          ...items[0].content,
                                                          // Heights the estimator cannot predict: the
                                                          // flat per-message guess is wrong in both
                                                          // directions across this run.
                                                          body: `Endless ${String(state.page)}-${String(index)} ${'wraps and wraps '.repeat((index % 5) * 4)}`,
                                                          html: `Endless ${String(state.page)}-${String(index)} ${'wraps and wraps '.repeat((index % 5) * 4)}`,
                                                        },
                                                      },
                                                    }))
                                                  : workerMode === 'delayed_history'
                                                    ? // Distinct ids: reusing the snapshot's would emit
                                                      // duplicate events, which no server does.
                                                      items.slice(0, -1).map((value, index) => ({
                                                        op: 'insert' as const,
                                                        index,
                                                        value: {
                                                          ...value,
                                                          id: `delayed-older-${String(index)}`,
                                                          event_id: `$delayed-older-${String(index)}:example.test`,
                                                          content: {
                                                            ...value.content,
                                                            body: `Delayed older ${String(index)}`,
                                                            html: `Delayed older ${String(index)}`,
                                                          },
                                                        },
                                                      }))
                                                    : workerMode === 'delayed_pagination'
                                                      ? Array.from({ length: 20 }, (_, index) => ({
                                                          op: 'insert' as const,
                                                          index: index + 1,
                                                          value: {
                                                            ...items[0],
                                                            id: `${room.name.toLowerCase()}-history-${String(state.page)}-${String(index)}`,
                                                            event_id: `$${room.name.toLowerCase()}-history-${String(state.page)}-${String(index)}`,
                                                            timestamp: 1_699_999_000_000 + index,
                                                            content: {
                                                              kind: 'message' as const,
                                                              body: `${room.name} history ${String(state.page)} ${String(index)}`,
                                                              html: `${room.name} history ${String(state.page)} ${String(index)}`,
                                                              emote: false,
                                                              edited: false,
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
                                                                html: `${room.name} history ${String(state.page)}`,
                                                                emote: false,
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
                                        workerMode === 'delayed_history'
                                          ? 750
                                          : workerMode === 'delayed_pagination'
                                            ? 1_500
                                            : // Long enough for the gesture to settle first, so a
                                              // test can tell the user's own scrolling apart from
                                              // the shift a prepend causes.
                                              workerMode === 'endless_history'
                                              ? 400
                                              : 0
                                      );
                                      return {
                                        type: 'paginate',
                                        direction,
                                        reached_end: reachedEnd,
                                      };
                                    })()
                                  : command === 'notification_settings'
                                    ? {
                                        type: 'notification_settings',
                                        room: null,
                                        default: 'all',
                                      }
                                    : command === 'default_notification_modes'
                                      ? {
                                          type: 'default_notification_modes',
                                          direct: 'all',
                                          group: 'mentions',
                                        }
                                      : command === 'mark_read' || command === 'set_typing'
                                        ? { type: command }
                                        : command === 'unsubscribe'
                                          ? { type: 'unsubscribe' }
                                          : command === 'search_messages'
                                            ? {
                                                type: 'search_messages',
                                                hits: searchHits(
                                                  request.command as unknown as Record<
                                                    string,
                                                    unknown
                                                  >
                                                ),
                                              }
                                            : command === 'space_hierarchy'
                                              ? hierarchyPage(
                                                  (request.command as { from?: string | null })
                                                    .from ?? ''
                                                )
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
                          html: `Delayed layout event ${'wraps '.repeat(80)}`,
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
