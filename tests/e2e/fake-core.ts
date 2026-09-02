import type { Page } from '@playwright/test';
import type { BookmarkView } from '#src/generated/BookmarkView';
import type { Command } from '#src/generated/Command';
import type { CommandOk } from '#src/generated/CommandOk';
import type { CoreEvent } from '#src/generated/CoreEvent';
import type { ProfileView } from '#src/generated/ProfileView';
import type { RoomSummary } from '#src/generated/RoomSummary';
import type { SessionInfo } from '#src/generated/SessionInfo';
import type { SidebarItemView } from '#src/generated/SidebarItemView';
import type { SpaceChildEdge } from '#src/generated/SpaceChildEdge';
import type { SpaceHierarchyRoomView } from '#src/generated/SpaceHierarchyRoomView';
import type { TimelineItemView } from '#src/generated/TimelineItemView';

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
    __e2eTimelineRebuilds: number;
  }
}

export async function installFakeCore(page: Page, mode: WorkerMode): Promise<void> {
  await page.addInitScript((workerMode: WorkerMode) => {
    type CommandType = Command['type'];
    type CommandFor<T extends CommandType> = Extract<Command, { type: T }>;
    type OkFor<T extends CommandType> = Extract<CommandOk, { type: T }>;
    type BareCommandType = {
      [T in CommandType]: keyof OkFor<T> extends 'type' ? T : never;
    }[CommandType];
    type RichCommandType = Exclude<CommandType, BareCommandType>;
    type Handler<T extends CommandType> = (
      command: CommandFor<T>,
      port: FakePort
    ) => OkFor<T> | typeof NO_REPLY;
    type Handlers = { [T in RichCommandType]: Handler<T> } & {
      [T in BareCommandType]?: Handler<T>;
    };

    const NO_REPLY = Symbol('no-reply');

    class FakeCoreError extends Error {
      constructor(readonly code: string) {
        super(code);
      }
    }

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
    const session: SessionInfo = {
      account_id: 'e2e-account',
      user_id: '@e2e:example.test',
      device_id: 'E2EDEVICE',
    };
    const profile: ProfileView = {
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
    const room: RoomSummary = {
      room_id: '!room:example.test',
      canonical_alias: null,
      name: 'General',
      topic: null,
      avatar_url: null,
      is_direct: false,
      direct_targets: [],
      join_rule: 'invite',
      tags: [],
      state: 'joined',
      encrypted: true,
      is_space: false,
      is_tombstoned: false,
      is_voice: false,
      call_participants: [],
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
        event_id: '$general-19:example.test',
      },
    };
    const secondRoom: RoomSummary = {
      ...room,
      room_id: '!second:example.test',
      name: 'Random',
    };
    const invitedRoom: RoomSummary = {
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
    const alphaSpace: RoomSummary = {
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
    const betaSpace: RoomSummary = { ...alphaSpace, room_id: '!beta:example.test', name: 'Beta' };
    const gammaSpace: RoomSummary = {
      ...alphaSpace,
      room_id: '!gamma:example.test',
      name: 'Gamma',
    };
    const successorRoom: RoomSummary = {
      ...room,
      room_id: '!successor:example.test',
      name: 'Successor',
      unread: 0,
      highlight: 0,
    };
    const tombstonedRoom: RoomSummary = {
      ...room,
      room_id: '!tombstoned:example.test',
      name: 'Old Room',
      is_tombstoned: true,
      unread: 0,
      highlight: 0,
    };
    const joinedRooms: RoomSummary[] =
      workerMode === 'spaces'
        ? [room, secondRoom, invitedRoom, alphaSpace, betaSpace, gammaSpace]
        : workerMode === 'tombstoned'
          ? [room, secondRoom, invitedRoom, tombstonedRoom, successorRoom]
          : [room, secondRoom, invitedRoom];

    const hierarchyRoom = (
      roomId: string,
      name: string,
      overrides: Partial<SpaceHierarchyRoomView> = {}
    ): SpaceHierarchyRoomView => ({
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

    const childEdge = (
      roomId: string,
      position: number,
      order: string | null = null
    ): SpaceChildEdge => ({
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

    const hierarchyPages: Record<
      string,
      { rooms: SpaceHierarchyRoomView[]; next_batch: string | null }
    > = {
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
    const recordChildOrder = (command: CommandFor<'set_space_child_order'>): void => {
      const stored: unknown = JSON.parse(sessionStorage.getItem(CHILD_ORDER_KEY) ?? '[]');
      const log = Array.isArray(stored) ? stored : [];
      log.push({
        space_id: command.space_id,
        room_id: command.room_id,
        order: command.order,
      });
      sessionStorage.setItem(CHILD_ORDER_KEY, JSON.stringify(log));
    };

    const SIDEBAR_KEY = 'e2e-space-sidebar';
    const readSidebar = (): SidebarItemView[] => {
      try {
        const stored: unknown = JSON.parse(sessionStorage.getItem(SIDEBAR_KEY) ?? '[]');
        return Array.isArray(stored) ? (stored as SidebarItemView[]) : [];
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
    const readBookmarks = (): BookmarkView[] => {
      try {
        const stored: unknown = JSON.parse(sessionStorage.getItem(BOOKMARKS_KEY) ?? '[]');
        return Array.isArray(stored) ? (stored as BookmarkView[]) : [];
      } catch {
        return [];
      }
    };
    const writeBookmarks = (entries: BookmarkView[]): void => {
      sessionStorage.setItem(BOOKMARKS_KEY, JSON.stringify(entries));
    };

    const timelineItems = (roomName: string): TimelineItemView[] =>
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
          notice: false,
          edited: false,
        },
        in_reply_to: null,
        thread_root: null,
        thread_summary: null,
        reactions: [],
        is_own: false,
        read_by: [],
        per_message_profile: null,
        mention: 'none',
      }));

    const searchHits = (payload: CommandFor<'search_messages'>) => {
      const query = payload.query.toLowerCase();
      const filter = payload.filter;
      const offset = payload.offset;
      const newestFirst = payload.order === 'recent';

      return [room, secondRoom]
        .filter(
          (candidate) =>
            (!filter.rooms.length || filter.rooms.includes(candidate.room_id)) &&
            !filter.not_rooms.includes(candidate.room_id)
        )
        .flatMap((candidate) =>
          timelineItems(candidate.name ?? '')
            .filter((item) => {
              if (item.content.kind !== 'message') return false;
              const body = item.content.body.toLowerCase();
              if (query !== '' && !query.split(/\s+/).every((word) => body.includes(word)))
                return false;
              if (filter.senders.length && !filter.senders.includes(item.sender ?? ''))
                return false;
              if (filter.not_senders.includes(item.sender ?? '')) return false;
              if (filter.exclude.some((term) => body.includes(term.toLowerCase()))) return false;
              return filter.phrases.every((phrase) => body.includes(phrase.toLowerCase()));
            })
            .map((item) => ({
              room_id: candidate.room_id,
              event_id: item.event_id ?? '',
              body: item.content.kind === 'message' ? item.content.body : '',
              sender: item.sender ?? '',
              origin_server_ts: item.timestamp,
              score: 1,
            }))
        )
        .sort((left, right) => (newestFirst ? right.origin_server_ts - left.origin_server_ts : 0))
        .slice(offset, offset + payload.limit);
    };

    const rooms = new Map<string, RoomSummary>([
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

    const servedBytes = new Map<string, Promise<Uint8Array>>();
    function servedPng(source: string): Promise<Uint8Array> {
      const [width, height] = source.includes('wide-') ? [1000, 400] : [80, 60];
      const key = `${String(width)}x${String(height)}`;
      let bytes = servedBytes.get(key);
      if (bytes === undefined) {
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d')?.clearRect(0, 0, width, height);
        bytes = canvas
          .convertToBlob({ type: 'image/png' })
          .then((blob) => blob.arrayBuffer())
          .then((buffer) => new Uint8Array(buffer));
        servedBytes.set(key, bytes);
      }
      return bytes;
    }

    const subscriptionRoom = (subscription: number): RoomSummary => {
      const state = subscriptions.get(subscription);
      if (!state) throw new Error(`unknown timeline subscription ${String(subscription)}`);
      const found = rooms.get(state.roomId);
      if (!found) throw new Error(`unknown timeline room ${state.roomId}`);
      return found;
    };

    const timelineSnapshot = (roomName: string): TimelineItemView[] => {
      const items = timelineItems(roomName);
      const first = items[0];
      const timelineStart: TimelineItemView = {
        ...first,
        id: `${roomName.toLowerCase()}-date-divider`,
        event_id: null,
        sender: null,
        sender_name: null,
        timestamp: 1_700_000_000_000,
        content: { kind: 'date_divider', timestamp: 1_700_000_000_000 },
      };
      const readMarker: TimelineItemView = {
        ...first,
        id: `${roomName.toLowerCase()}-read-marker`,
        event_id: null,
        sender: null,
        sender_name: null,
        content: { kind: 'read_marker' },
      };
      switch (workerMode) {
        case 'empty_room':
          return [];
        case 'delayed_snapshot':
          return items.slice(-1);
        case 'delayed_history':
          return items.map((item, index) => ({
            ...item,
            content: {
              kind: 'message',
              body: `Delayed history ${String(index)}`,
              html: `Delayed history ${String(index)}`,
              emote: false,
              notice: false,
              edited: false,
            },
          }));
        case 'delayed_pagination':
          return [timelineStart, ...items];
        case 'unread':
          return [...items.slice(0, 5), readMarker, ...items.slice(5)];
        default:
          return items;
      }
    };

    const messageContent = (
      body: string
    ): Extract<TimelineItemView['content'], { kind: 'message' }> => ({
      kind: 'message',
      body,
      html: body,
      emote: false,
      notice: false,
      edited: false,
    });

    const paginationDiffs = (
      roomName: string,
      page: number
    ): Extract<CoreEvent, { type: 'timeline_diff' }>['diffs'] => {
      const items = timelineItems(roomName);
      const first = items[0];
      switch (workerMode) {
        case 'empty_room':
          return [];
        case 'endless_history':
          return Array.from({ length: 20 }, (_, index) => ({
            op: 'insert',
            index: index + 1,
            value: {
              ...first,
              id: `endless-${String(page)}-${String(index)}`,
              event_id: `$endless-${String(page)}-${String(index)}:example.test`,
              timestamp: 1_600_000_000_000 + page * 100 + index,
              content: messageContent(
                `Endless ${String(page)}-${String(index)} ${'wraps and wraps '.repeat((index % 5) * 4)}`
              ),
            },
          }));
        case 'delayed_history':
          return items.slice(0, -1).map((value, index) => ({
            op: 'insert',
            index,
            value: {
              ...value,
              id: `delayed-older-${String(index)}`,
              event_id: `$delayed-older-${String(index)}:example.test`,
              content: messageContent(`Delayed older ${String(index)}`),
            },
          }));
        case 'delayed_pagination':
          return Array.from({ length: 20 }, (_, index) => ({
            op: 'insert',
            index: index + 1,
            value: {
              ...first,
              id: `${roomName.toLowerCase()}-history-${String(page)}-${String(index)}`,
              event_id: `$${roomName.toLowerCase()}-history-${String(page)}-${String(index)}`,
              timestamp: 1_699_999_000_000 + index,
              content: messageContent(`${roomName} history ${String(page)} ${String(index)}`),
            },
          }));
        default:
          return [
            {
              op: 'push_front',
              value: {
                ...first,
                id: `${roomName.toLowerCase()}-history-${String(page)}`,
                event_id: `$${roomName.toLowerCase()}-history-${String(page)}`,
                content: messageContent(`${roomName} history ${String(page)}`),
              },
            },
          ];
      }
    };

    const paginationDelay = (): number => {
      switch (workerMode) {
        case 'delayed_history':
          return 750;
        case 'delayed_pagination':
          return 1_500;
        case 'endless_history':
          return 400;
        default:
          return 0;
      }
    };

    const handlers: Handlers = {
      discover_homeserver: () => ({
        type: 'discover_homeserver',
        homeserver: 'https://example.test',
      }),
      login: () => ({ type: 'login', user_id: session.user_id }),
      login_flows: () => ({
        type: 'login_flows',
        flows: {
          password: true,
          oidc: false,
          oidc_registration: false,
          sso: false,
          oauth_aware_preferred: false,
          sso_identity_providers: [],
        },
      }),
      registration_flows: () => ({
        type: 'registration_flows',
        flows: { uiaa: true, email: 'unavailable', registration_token: 'unavailable' },
      }),
      register: () => ({
        type: 'register',
        result: { state: 'complete', user_id: session.user_id },
      }),
      continue_registration: () => ({
        type: 'continue_registration',
        result: { state: 'complete', user_id: session.user_id },
      }),
      request_registration_email: () => ({
        type: 'request_registration_email',
        result: { state: 'complete', user_id: session.user_id },
      }),
      submit_registration_email: () => ({
        type: 'submit_registration_email',
        result: { state: 'complete', user_id: session.user_id },
      }),
      start_oidc_login: () => ({
        type: 'start_oidc_login',
        authorization_url: 'https://example.test/authorize',
      }),
      complete_oidc_login: () => ({ type: 'complete_oidc_login', user_id: session.user_id }),
      start_sso_login: () => ({
        type: 'start_sso_login',
        authorization_url: 'https://example.test/sso',
      }),
      complete_sso_login: () => ({ type: 'complete_sso_login', user_id: session.user_id }),
      restore: () => {
        if (workerMode === 'loading') return NO_REPLY;
        if (workerMode === 'error') throw new FakeCoreError('failed');
        return { type: 'restore', session };
      },
      list_accounts: () => ({ type: 'list_accounts', accounts: [session] }),
      switch_account: () => ({ type: 'switch_account', session }),
      homeserver_info: () => ({
        type: 'homeserver_info',
        homeserver: 'https://example.test',
        server: { name: 'Sable Test', version: '1.0' },
      }),
      subscribe_room_list: () => ({
        type: 'subscribe_room_list',
        subscription: 1,
        rooms: joinedRooms,
      }),
      subscribe_timeline: (command) => {
        const subscription = nextSubscription++;
        subscriptions.set(subscription, { roomId: command.room_id, page: 0 });
        timelineRooms.push(command.room_id);
        timelineSubscriptions.push(subscription);
        return {
          type: 'subscribe_timeline',
          subscription,
          items: timelineSnapshot(subscriptionRoom(subscription).name ?? ''),
        };
      },
      paginate: (command, port) => {
        const state = subscriptions.get(command.subscription);
        if (!state) throw new Error('unknown timeline subscription');
        const paginated = subscriptionRoom(command.subscription);
        const roomName = paginated.name ?? '';
        state.page += 1;
        const page = state.page;
        const reachedEnd =
          workerMode === 'endless_history'
            ? false
            : workerMode === 'empty_room' || workerMode === 'delayed_history' || page >= 2;
        port.emit({
          type: 'timeline_pagination',
          subscription: command.subscription,
          loading: true,
          reached_start: false,
        });
        window.setTimeout(() => {
          port.emit({
            type: 'timeline_diff',
            subscription: command.subscription,
            diffs: paginationDiffs(roomName, page),
          });
          port.emit({
            type: 'timeline_pagination',
            subscription: command.subscription,
            loading: false,
            reached_start: reachedEnd,
          });
        }, paginationDelay());
        return { type: 'paginate', direction: command.direction, reached_end: reachedEnd };
      },
      room_members: () => ({
        type: 'room_members',
        members: [
          {
            user_id: '@alice:example.test',
            display_name: 'Alice',
            avatar_url: null,
            power_level: 100,
            membership: 'join',
            member_ts: null,
            kicked: false,
          },
        ],
      }),
      search_messages: (command) => ({ type: 'search_messages', hits: searchHits(command) }),
      join_call: () => ({
        type: 'join_call',
        session: 1,
        url: 'wss://sfu.example.test',
        jwt: 'e2e-jwt',
        identity: `${session.user_id}:${session.device_id}`,
        encrypt_media: false,
      }),
      call_support: () => ({ type: 'call_support', has_focus: false, can_join: false }),
      room_permissions: (command) => {
        const canPost = command.room_id !== secondRoom.room_id;
        return {
          type: 'room_permissions',
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
        };
      },
      notification_settings: () => ({
        type: 'notification_settings',
        room: null,
        default: 'all',
      }),
      default_notification_modes: () => ({
        type: 'default_notification_modes',
        direct: 'all',
        group: 'mentions',
      }),
      notification: () => ({ type: 'notification', notification: null }),
      image_packs: () => ({ type: 'image_packs', packs: [] }),
      all_image_packs: () => ({ type: 'all_image_packs', packs: [] }),
      user_profile: (command) => {
        const localpart = command.user_id.replace(/^@/, '').split(':')[0];
        return {
          type: 'user_profile',
          profile: {
            ...profile,
            user_id: command.user_id,
            display_name:
              command.user_id === profile.user_id
                ? profile.display_name
                : `${localpart.charAt(0).toUpperCase()}${localpart.slice(1)}`,
          },
        };
      },
      user_relations: () => ({ type: 'user_relations', mutual_rooms: [], ignored: false }),
      account_contacts: () => ({ type: 'account_contacts', emails: [] }),
      ignored_users: () => ({ type: 'ignored_users', users: [] }),
      bulk_redact: () => ({ type: 'bulk_redact', redacted: 0 }),
      pinned_events: () => ({ type: 'pinned_events', event_ids: [] }),
      set_pinned: () => ({ type: 'set_pinned', event_ids: [] }),
      room_power_levels: () => ({
        type: 'room_power_levels',
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
        events_default: 0,
        state_default: 50,
        users_default: 0,
        events: {},
        users: { [session.user_id]: 100 },
        notifications_room: 50,
      }),
      room_versions: () => ({
        type: 'room_versions',
        default: '10',
        available: [
          { id: '10', stable: true },
          { id: '11', stable: true },
        ],
      }),
      room_aliases: () => ({ type: 'room_aliases', aliases: [] }),
      public_rooms: () => ({
        type: 'public_rooms',
        rooms: [],
        next_batch: null,
        total: 0,
      }),
      room_directory_visibility: () => ({ type: 'room_directory_visibility', public: false }),
      upgrade_room: () => ({ type: 'upgrade_room', replacement_room: successorRoom.room_id }),
      room_state_event: (command) => ({
        type: 'room_state_event',
        content:
          command.event_type === 'm.room.tombstone' && command.room_id === tombstonedRoom.room_id
            ? { replacement_room: successorRoom.room_id, body: null }
            : null,
      }),
      room_state_events: (command) => {
        const content =
          command.event_type === 'im.vector.modular.widgets'
            ? roomWidgets.get(command.room_id)
            : undefined;
        return {
          type: 'room_state_events',
          events: content ? [{ state_key: WIDGET_STATE_KEY, content }] : [],
        };
      },
      url_preview: (command) => ({
        type: 'url_preview',
        preview:
          command.url === 'https://example.test/article'
            ? {
                url: command.url,
                title: 'The Example Article',
                description: 'A short description of the article.',
                site_name: 'Example',
                image: null,
                image_width: null,
                image_height: null,
              }
            : null,
      }),
      list_threads: () => ({ type: 'list_threads', roots: [], next_batch: null }),
      notification_keywords: () => ({
        type: 'notification_keywords',
        keywords: [...notificationKeywords],
      }),
      timestamp_to_event: () => ({ type: 'timestamp_to_event', event_id: null }),
      room_account_data: () => ({ type: 'room_account_data', content: null }),
      account_data_types: () => ({ type: 'account_data_types', event_types: [] }),
      access_token: () => ({ type: 'access_token', token: 'e2e-access-token' }),
      account_data: () => ({ type: 'account_data', content: null }),
      event_source: () => ({ type: 'event_source', source: '{}' }),
      personas: () => ({
        type: 'personas',
        catalog: { personas: [], account: null, rooms: {} },
      }),
      save_persona: () => ({ type: 'save_persona', personas: [] }),
      remove_persona: () => ({ type: 'remove_persona', personas: [] }),
      bookmarks: () => ({ type: 'bookmarks', bookmarks: readBookmarks() }),
      set_bookmark: (command) => {
        const entries = readBookmarks().filter(
          (entry) => !(entry.room_id === command.room_id && entry.event_id === command.event_id)
        );
        if (command.bookmarked) {
          const bookmarkedRoom = rooms.get(command.room_id);
          const item = bookmarkedRoom
            ? timelineItems(bookmarkedRoom.name ?? '').find(
                (candidate) => candidate.event_id === command.event_id
              )
            : undefined;
          entries.push({
            bookmark_id: `${command.room_id}|${command.event_id}`,
            room_id: command.room_id,
            event_id: command.event_id,
            room_name: bookmarkedRoom?.name ?? null,
            sender: item?.sender ?? null,
            body_preview: item?.content.kind === 'message' ? item.content.body : null,
            event_ts: item?.timestamp ?? command.now_ms,
            bookmarked_ts: command.now_ms,
          });
        }
        writeBookmarks(entries);
        return { type: 'set_bookmark', bookmarked: command.bookmarked };
      },
      room_timeline_events: () => ({ type: 'room_timeline_events', events: [] }),
      room_state_events_raw: () => ({ type: 'room_state_events_raw', events: [] }),
      search_user_directory: () => ({
        type: 'search_user_directory',
        limited: false,
        results: [],
      }),
      open_id_token: () => ({
        type: 'open_id_token',
        token: {
          access_token: 'e2e-openid',
          token_type: 'Bearer',
          matrix_server_name: 'example.test',
          expires_in_ms: 3_600_000,
        },
      }),
      schedule_message: () => ({ type: 'schedule_message', delay_id: 'e2e-delay' }),
      scheduled_messages: () => ({ type: 'scheduled_messages', messages: [] }),
      delayed_events_supported: () => ({ type: 'delayed_events_supported', supported: true }),
      cancel_send: () => ({ type: 'cancel_send', cancelled: true }),
      create_room: () => ({ type: 'create_room', room_id: '!created:example.test' }),
      create_dm: () => ({ type: 'create_dm', room_id: '!dm:example.test' }),
      space_hierarchy: (command) => {
        if (command.space_id === '!refused:example.test') throw new FakeCoreError('failed');
        const page = hierarchyPages[`${command.space_id}|${command.from ?? ''}`] ?? {
          rooms: [],
          next_batch: null,
        };
        return { type: 'space_hierarchy', rooms: page.rooms, next_batch: page.next_batch };
      },
      space_sidebar: () => ({ type: 'space_sidebar', items: readSidebar() }),
      room_preview: (command) => ({
        type: 'room_preview',
        preview: {
          room_id: command.address,
          canonical_alias: null,
          name: 'Preview Room',
          topic: null,
          avatar_url: null,
          is_space: false,
          is_voice: false,
          num_joined_members: 3,
          join_rule: 'public',
          state: null,
        },
      }),
      join_room: (command) => ({ type: 'join_room', room_id: command.address }),
      knock_room: (command) => ({ type: 'knock_room', room_id: command.address }),
      room_via_servers: () => ({ type: 'room_via_servers', servers: ['example.test'] }),
      sync_status: () => ({
        type: 'sync_status',
        status: { state: 'live' },
      }),
      encryption_status: () => ({
        type: 'encryption_status',
        status: {
          verification: 'verified',
          recovery: 'enabled',
          cross_signing_ready: true,
        },
      }),
      search_coverage: () => ({
        type: 'search_coverage',
        coverage: { documents: 0, rooms_pending: 0, rooms_failed: 0, state: 'complete' },
      }),
      devices: () => ({
        type: 'devices',
        account_management: false,
        devices: [
          {
            device_id: session.device_id,
            display_name: 'This browser',
            is_verified: true,
            is_own: true,
            last_seen_ts: null,
            last_seen_ip: null,
          },
          {
            device_id: 'PHONE',
            display_name: 'Phone',
            is_verified: false,
            is_own: false,
            last_seen_ts: null,
            last_seen_ip: null,
          },
        ],
      }),
      enable_recovery: () => ({ type: 'enable_recovery', recovery_key: 'e2e-recovery-key' }),
      reset_recovery_key: () => ({ type: 'reset_recovery_key', recovery_key: 'e2e-recovery-key' }),
      delete_device: () => ({ type: 'delete_device', management_url: null }),
      request_verification: () => ({ type: 'request_verification', flow_id: 'e2e-flow' }),
      add_notification_keyword: (command) => {
        if (command.keyword === 'network-fail') throw new FakeCoreError('failed');
        if (!notificationKeywords.includes(command.keyword))
          notificationKeywords.push(command.keyword);
        return { type: 'add_notification_keyword' };
      },
      remove_notification_keyword: (command) => {
        if (command.keyword === 'stuck-keyword') throw new FakeCoreError('failed');
        const index = notificationKeywords.indexOf(command.keyword);
        if (index !== -1) notificationKeywords.splice(index, 1);
        return { type: 'remove_notification_keyword' };
      },
      send_state_event: (command) => {
        if (command.event_type === 'im.vector.modular.widgets')
          roomWidgets.set(command.room_id, null);
        return { type: 'send_state_event' };
      },
      set_space_child_order: (command) => {
        recordChildOrder(command);
        return { type: 'set_space_child_order' };
      },
      set_space_sidebar: (command, port) => {
        sessionStorage.setItem(SIDEBAR_KEY, JSON.stringify(command.items));
        window.setTimeout(() => {
          port.emit({ type: 'space_sidebar_changed', items: command.items });
        });
        return { type: 'set_space_sidebar' };
      },
    };

    const bareReply = <T extends CommandType>(type: T): OkFor<T> => ({ type }) as OkFor<T>;

    const dispatch = (command: Command, port: FakePort): CommandOk | typeof NO_REPLY => {
      const handler = (handlers as Record<string, Handler<CommandType> | undefined>)[command.type];
      if (!handler) return bareReply(command.type);
      return handler(command, port);
    };

    const replyDelay = (type: CommandType): number => {
      if (type === 'paginate') return 500;
      if (
        type === 'subscribe_timeline' &&
        (workerMode === 'delayed_snapshot' || workerMode === 'delayed_history')
      )
        return 750;
      return 0;
    };

    class FakePort {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onmessageerror: ((event: MessageEvent) => void) | null = null;

      start(): void {}

      close(): void {}

      emit(event: CoreEvent): void {
        this.onmessage?.({ data: { event } } as MessageEvent);
      }

      postMessage(request: {
        id: number;
        command?: Command;
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
        const command = request.command;
        if (!command) return;
        commandLog.push(command.type);

        let response: { id: number; ok: CommandOk } | { id: number; err: { code: string } };
        try {
          const result = dispatch(command, this);
          if (result === NO_REPLY) return;
          response = { id: request.id, ok: result };
        } catch (error) {
          if (!(error instanceof FakeCoreError)) throw error;
          response = { id: request.id, err: { code: error.code } };
        }

        window.setTimeout(() => {
          this.onmessage?.({ data: response } as MessageEvent);
          if (!('ok' in response) || response.ok.type !== 'subscribe_timeline') return;
          const { subscription } = response.ok;
          const subscribed = rooms.get(subscriptions.get(subscription)?.roomId ?? '');
          if (!subscribed) return;
          this.emit({
            type: 'timeline_pagination',
            subscription,
            loading: false,
            reached_start: false,
          });
          if (workerMode !== 'delayed_layout_diff') return;
          window.setTimeout(() => {
            const last = timelineItems(subscribed.name ?? '').at(-1);
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
                    content: messageContent(`Delayed layout event ${'wraps '.repeat(80)}`),
                  },
                },
              ],
            });
          }, 750);
        }, replyDelay(command.type));
      }
    }

    Object.defineProperty(window, '__e2eEmitTimelineEvent', {
      configurable: true,
      value: (event: unknown) => activePort?.emit(event as CoreEvent),
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
