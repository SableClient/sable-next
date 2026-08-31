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
  | 'spaces'
  | 'tombstoned';

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
      direct_targets: [] as string[],
      join_rule: 'invite',
      tags: [] as string[],
      state: 'joined',
      encrypted: true,
      is_space: false,
      is_tombstoned: false,
      is_voice: false,
      call_participants: [] as string[],
      has_space_parent: false,
      supports_knock: false,
      supports_restricted: false,
      supports_knock_restricted: false,
      space_children: [],
      unread: 2,
      highlight: 1,
      marked_unread: false,
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
      topic:
        'A topic long enough to clamp: it introduces the space, lists the rules, thanks the moderators and links the map. It repeats itself at length so the hero has something to cut: the rules again, the moderators again, the map again, and a closing paragraph that keeps going well past the three lines the hero shows before it hands the rest to the dialog.',
      is_space: true,
      encrypted: false,
      unread: 0,
      highlight: 0,
      latest_event: null,
    };
    const betaSpace = { ...alphaSpace, room_id: '!beta:example.test', name: 'Beta' };
    const gammaSpace = { ...alphaSpace, room_id: '!gamma:example.test', name: 'Gamma' };
    const successorRoom = {
      ...room,
      room_id: '!successor:example.test',
      name: 'Successor',
      unread: 0,
      highlight: 0,
    };
    const tombstonedRoom = {
      ...room,
      room_id: '!tombstoned:example.test',
      name: 'Old Room',
      is_tombstoned: true,
      unread: 0,
      highlight: 0,
    };
    const joinedRooms =
      workerMode === 'spaces'
        ? [room, secondRoom, invitedRoom, alphaSpace, betaSpace, gammaSpace]
        : workerMode === 'tombstoned'
          ? [room, secondRoom, invitedRoom, tombstonedRoom, successorRoom]
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

    const alphaChildren = [
      childEdge('!nested:example.test', 1, 'a'),
      childEdge('!late:example.test', 2, 'b'),
      childEdge('!middle:example.test', 3, 'c'),
      childEdge('!tail:example.test', 4, 'd'),
      childEdge('!refused:example.test', 5, 'e'),
    ];

    const hierarchyPages: Record<string, { rooms: unknown[]; next_batch: string | null }> = {
      '!alpha:example.test|': {
        rooms: [
          hierarchyRoom('!alpha:example.test', 'Alpha', {
            is_space: true,
            children: alphaChildren,
          }),
          hierarchyRoom('!nested:example.test', 'Nested', { is_space: true }),
          hierarchyRoom('!refused:example.test', 'Refused Space', { is_space: true }),
        ],
        next_batch: 'page-two',
      },
      '!alpha:example.test|page-two': {
        rooms: [
          hierarchyRoom('!late:example.test', 'Late Arrival'),
          hierarchyRoom('!middle:example.test', 'Middle Room'),
          hierarchyRoom('!tail:example.test', 'Tail Room'),
        ],
        next_batch: null,
      },
      '!nested:example.test|': {
        rooms: [
          hierarchyRoom('!nested:example.test', 'Nested', {
            is_space: true,
            children: [childEdge('!deep:example.test', 1)],
          }),
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

    const hierarchyPage = (spaceId: string, from: string) => {
      const page = hierarchyPages[`${spaceId}|${from}`] ?? { rooms: [], next_batch: null };
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

    const WIDGET_STATE_KEY = 'dashboard';
    const roomWidgets = new Map<string, Record<string, unknown> | null>([
      [
        room.room_id,
        {
          type: 'grafana',
          url: 'https://widgets.example.test/dashboard?user=$matrix_user_id&room=$matrix_room_id&name=$matrix_display_name',
          name: 'Dashboard',
          data: {},
        },
      ],
      [
        secondRoom.room_id,
        {
          type: 'grafana',
          url: 'https://widgets.example.test/dashboard?user=$matrix_user_id&room=$matrix_room_id&name=$matrix_display_name',
          name: 'Dashboard',
          data: {},
        },
      ],
    ]);

    const BOOKMARKS_KEY = 'e2e-bookmarks';
    type StoredBookmark = {
      bookmark_id: string;
      room_id: string;
      event_id: string;
      room_name: string | null;
      sender: string | null;
      body_preview: string | null;
      event_ts: number;
      bookmarked_ts: number;
    };
    const readBookmarks = (): StoredBookmark[] => {
      try {
        const stored: unknown = JSON.parse(sessionStorage.getItem(BOOKMARKS_KEY) ?? '[]');
        return Array.isArray(stored) ? (stored as StoredBookmark[]) : [];
      } catch {
        return [];
      }
    };
    const writeBookmarks = (entries: StoredBookmark[]): void => {
      sessionStorage.setItem(BOOKMARKS_KEY, JSON.stringify(entries));
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
      [tombstonedRoom.room_id, tombstonedRoom],
      [successorRoom.room_id, successorRoom],
    ]);
    let nextSubscription = 2;
    const subscriptions = new Map<number, { roomId: string; page: number }>();
    const notificationKeywords: string[] = [];
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
        reset?: true;
      }): void {
        if (request.reset) {
          window.setTimeout(() => {
            this.onmessage?.({ data: { id: request.id, uri: null } } as MessageEvent);
          });
          return;
        }
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
        if (command === 'notification_keywords') {
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, keywords: [...notificationKeywords] } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'add_notification_keyword') {
          const keyword = (request.command as { keyword?: string }).keyword ?? '';
          window.setTimeout(() => {
            if (keyword === 'network-fail') {
              this.onmessage?.({
                data: { id: request.id, err: { code: 'failed' } },
              } as MessageEvent);
              return;
            }
            if (!notificationKeywords.includes(keyword)) notificationKeywords.push(keyword);
            this.onmessage?.({
              data: { id: request.id, ok: { type: command } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'remove_notification_keyword') {
          const keyword = (request.command as { keyword?: string }).keyword ?? '';
          window.setTimeout(() => {
            if (keyword === 'stuck-keyword') {
              this.onmessage?.({
                data: { id: request.id, err: { code: 'failed' } },
              } as MessageEvent);
              return;
            }
            const index = notificationKeywords.indexOf(keyword);
            if (index !== -1) notificationKeywords.splice(index, 1);
            this.onmessage?.({
              data: { id: request.id, ok: { type: command } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'room_state_events') {
          const { room_id: roomId, event_type: eventType } = request.command as {
            room_id?: string;
            event_type?: string;
          };
          const content =
            eventType === 'im.vector.modular.widgets' ? roomWidgets.get(roomId ?? '') : undefined;
          const events = content ? [{ state_key: WIDGET_STATE_KEY, content }] : [];
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, events } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'room_state_event') {
          const { room_id: roomId, event_type: eventType } = request.command as {
            room_id?: string;
            event_type?: string;
          };
          const content =
            eventType === 'm.room.tombstone' && roomId === tombstonedRoom.room_id
              ? { replacement_room: successorRoom.room_id, body: null }
              : null;
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, content } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'send_state_event') {
          const { room_id: roomId, event_type: eventType } = request.command as {
            room_id?: string;
            event_type?: string;
          };
          if (eventType === 'im.vector.modular.widgets' && roomId) roomWidgets.set(roomId, null);
          window.setTimeout(() => {
            this.onmessage?.({ data: { id: request.id, ok: { type: command } } } as MessageEvent);
          });
          return;
        }
        if (command === 'url_preview') {
          const { url } = request.command as { url?: string };
          const preview =
            url === 'https://example.test/article'
              ? {
                  url,
                  title: 'The Example Article',
                  description: 'A short description of the article.',
                  site_name: 'Example',
                  image: null,
                  image_width: null,
                  image_height: null,
                }
              : null;
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, preview } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'bookmarks') {
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, bookmarks: readBookmarks() } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'set_bookmark') {
          const {
            room_id: roomId,
            event_id: eventId,
            bookmarked,
            now_ms: nowMs,
          } = request.command as unknown as {
            room_id: string;
            event_id: string;
            bookmarked: boolean;
            now_ms: number;
          };
          const entries = readBookmarks().filter(
            (entry) => !(entry.room_id === roomId && entry.event_id === eventId)
          );
          if (bookmarked) {
            const bookmarkedRoom = rooms.get(roomId);
            const item = bookmarkedRoom
              ? timelineItems(bookmarkedRoom.name).find(
                  (candidate) => candidate.event_id === eventId
                )
              : undefined;
            entries.push({
              bookmark_id: `${roomId}|${eventId}`,
              room_id: roomId,
              event_id: eventId,
              room_name: bookmarkedRoom?.name ?? null,
              sender: item?.sender ?? null,
              body_preview: item?.content.body ?? null,
              event_ts: item?.timestamp ?? nowMs,
              bookmarked_ts: nowMs,
            });
          }
          writeBookmarks(entries);
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, bookmarked } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'list_threads') {
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, roots: [], next_batch: null } },
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
                  can_pin: canPost,
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
        if (command === 'personas') {
          window.setTimeout(() => {
            this.onmessage?.({
              data: {
                id: request.id,
                ok: { type: command, catalog: { personas: [], account: null, rooms: {} } },
              },
            } as MessageEvent);
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
        if (command === 'scheduled_messages') {
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, messages: [] } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'delayed_events_supported') {
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, supported: true } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'schedule_message') {
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, delay_id: 'e2e-delay' } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'cancel_scheduled_message' || command === 'send_scheduled_message') {
          window.setTimeout(() => {
            this.onmessage?.({ data: { id: request.id, ok: { type: command } } } as MessageEvent);
          });
          return;
        }
        if (command === 'open_id_token') {
          window.setTimeout(() => {
            this.onmessage?.({
              data: {
                id: request.id,
                ok: {
                  type: command,
                  token: {
                    access_token: 'e2e-openid',
                    token_type: 'Bearer',
                    matrix_server_name: 'example.test',
                    expires_in_ms: 3_600_000,
                  },
                },
              },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'room_timeline_events' || command === 'room_state_events_raw') {
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, events: [] } },
            } as MessageEvent);
          });
          return;
        }
        if (command === 'search_user_directory') {
          window.setTimeout(() => {
            this.onmessage?.({
              data: { id: request.id, ok: { type: command, limited: false, results: [] } },
            } as MessageEvent);
          });
          return;
        }

        const refusedHierarchy =
          command === 'space_hierarchy' &&
          (request.command as { space_id?: string }).space_id === '!refused:example.test';

        const response =
          (workerMode === 'error' && command === 'restore') || refusedHierarchy
            ? { id: request.id, err: { code: 'failed' } }
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
                                      : command === 'mark_read' ||
                                          command === 'mark_unread' ||
                                          command === 'set_typing' ||
                                          command === 'set_room_account_data'
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
                                                  (request.command as { space_id?: string })
                                                    .space_id ?? '',
                                                  (request.command as { from?: string | null })
                                                    .from ?? ''
                                                )
                                              : command === 'pinned_events' ||
                                                  command === 'set_pinned'
                                                ? { type: command, event_ids: [] }
                                                : command === 'room_account_data'
                                                  ? { type: command, content: null }
                                                  : command === 'event_source'
                                                    ? { type: command, source: '{}' }
                                                    : command === 'public_rooms'
                                                      ? {
                                                          type: command,
                                                          rooms: [],
                                                          next_batch: null,
                                                          total: 0,
                                                        }
                                                      : command === 'homeserver_info'
                                                        ? {
                                                            type: command,
                                                            homeserver: 'https://example.test',
                                                            server: {
                                                              name: 'Sable Test',
                                                              version: '1.0',
                                                            },
                                                          }
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
