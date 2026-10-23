import type { Page } from '@playwright/test';
import type {
  AbbreviationView,
  BookmarkView,
  CoreEvent,
  EncryptionStatusView,
  EventNotificationsView,
  ImagePackView,
  KeyBackupDownloadView,
  KeywordNotificationView,
  MentionNotificationsView,
  ProfileView,
  MemberView,
  RoomListItemView,
  RpcMethods,
  TimelineFocusView,
  RpcParams,
  RpcResult,
  SessionInfo,
  SidebarItemView,
  SpaceChildEdge,
  SpaceHierarchyRoomView,
  SubscriptionId,
  TimelineItemView,
  Rpc,
} from '#src/generated/protocol';

export type RoomCoreMode =
  | 'ready'
  | 'room_name_overflow'
  | 'thread_links'
  | 'thread_error'
  | 'loading'
  | 'error'
  | 'delayed_history'
  | 'unread'
  | 'unread_history'
  | 'unread_context_error'
  | 'unread_catchup'
  | 'forward_history'
  | 'delayed_media'
  | 'delayed_pagination'
  | 'endless_history'
  | 'delayed_snapshot'
  | 'empty_room'
  | 'delayed_layout_diff'
  | 'spaces'
  | 'tombstoned'
  | 'voice'
  | 'calendar'
  | 'forum'
  | 'unverified'
  | 'onboarding';

type WorkerMode = RoomCoreMode;

declare global {
  interface Window {
    __e2eCommands: string[];
    __e2eAccounts?: SessionInfo[];
    __e2eSwitchAccountError?: boolean;
    __e2eSwitchAccountDelayMs?: number;
    __e2eCalls: { method: string; params: unknown }[];
    __e2eProfileSaveError?: boolean;
    __e2eSendError?: string;
    __e2eFetchMedia?: (source: string, width: number, height: number) => Promise<Uint8Array>;
    __e2eMembers?: MemberView[];
    __e2eRelationEvents?: unknown[];
    __e2eMediaReady?: Promise<void>;
    __e2eReleaseMedia: () => void;
    __e2eAnchorPositions: number[];
    __e2eTimelineRooms: string[];
    __e2eTimelineSubscriptions: number[];
    __e2eTimelineFocus: TimelineFocusView[];
    __e2ePaginationDirections: string[];
    __e2eRefreshRoom: () => void;
    __e2eReceiveMessage: (body: string) => void;
    __e2eEmitTimelineEvent: (event: unknown) => void;
    __e2eTimelineRebuilds: number;
  }
}

export async function installFakeCore(page: Page, mode: WorkerMode): Promise<void> {
  await page.addInitScript((workerMode: WorkerMode) => {
    window.__e2ePaginationDirections = [];
    window.__e2eTimelineFocus = [];
    /** Keyed by wire method; a missing one answers `null`. */
    type RpcHandlers = {
      [M in keyof RpcMethods]?: (
        params: RpcParams<RpcMethods[M]>,
        port: FakePort
      ) => RpcResult<RpcMethods[M]> | typeof NO_REPLY;
    };

    const NO_REPLY = Symbol('no-reply');

    class FakeCoreError extends Error {
      constructor(readonly code: string) {
        super(code);
      }
    }

    const commandLog: string[] = [];
    const calls: { method: string; params: unknown }[] = [];
    const timelineRooms: string[] = [];
    const timelineSubscriptions: number[] = [];
    Object.defineProperty(window, '__e2eCommands', {
      configurable: true,
      value: commandLog,
    });
    Object.defineProperty(window, '__e2eCalls', {
      configurable: true,
      value: calls,
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
      homeserver: 'https://example.test',
      needs_reauth: false,
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
      supporter_awards: null,
      legacy_fields: [],
    };
    const summary = (raw: Omit<RoomListItemView, 'notification' | 'counts'>): RoomListItemView => ({
      ...raw,
      notification: { room: null, default: raw.is_direct ? 'all' : 'mentions' },
      counts: {
        unread: Math.max(raw.unread, raw.highlight),
        notifying: Math.max(raw.notifying, raw.highlight),
        highlight: raw.highlight,
        marked: raw.marked_unread,
      },
    });
    const room: RoomListItemView = summary({
      room_id: '!room:example.test',
      canonical_alias: null,
      name: workerMode === 'room_name_overflow' ? 'Room name fits until hover' : 'General',
      topic: null,
      avatar_url: null,
      is_direct: false,
      direct_targets: [],
      join_rule: 'invite',
      tags: [],
      state: 'joined',
      encrypted: true,
      is_tombstoned: false,
      call_participants: [],
      screen_sharers: [],
      room_kind: workerMode === 'calendar' ? 'calendar' : workerMode === 'forum' ? 'forum' : 'text',
      supports_knock: false,
      supports_restricted: false,
      supports_knock_restricted: false,
      space_children: [],
      unread:
        workerMode === 'room_name_overflow'
          ? 0
          : workerMode === 'unread_history' || workerMode === 'unread_context_error'
            ? 9_995
            : workerMode === 'unread_catchup'
              ? 75
              : 2,
      notifying: workerMode === 'room_name_overflow' ? 0 : 2,
      highlight: workerMode === 'room_name_overflow' ? 0 : 1,
      marked_unread: false,
      latest_event: {
        sender: '@alice:example.test',
        body: 'General message 19',
        timestamp: 1_700_000_000_019,
        sending: false,
        event_id: '$general-19:example.test',
      },
    });
    const secondRoom: RoomListItemView = summary({
      ...room,
      room_id: '!second:example.test',
      name: 'Random',
      unread: 3,
      notifying: 3,
      highlight: 0,
    });
    const invitedRoom: RoomListItemView = summary({
      ...room,
      room_id: '!invited:example.test',
      name: 'Design crew',
      topic: 'Where the redesign happens.',
      state: 'invited',
      unread: 0,
      notifying: 0,
      highlight: 0,
      latest_event: {
        sender: '@ada:example.test',
        body: 'invited you',
        timestamp: 1_700_000_000_000,
        sending: false,
        event_id: null,
      },
    });
    const alphaSpace: RoomListItemView = summary({
      ...room,
      room_id: '!alpha:example.test',
      name: 'Alpha',
      topic:
        'A topic long enough to clamp: it introduces the space, lists the rules, thanks the moderators and links the map. It repeats itself at length so the hero has something to cut: the rules again, the moderators again, the map again, and a closing paragraph that keeps going well past the three lines the hero shows before it hands the rest to the dialog.',
      room_kind: 'space',
      encrypted: false,
      unread: 0,
      notifying: 0,
      highlight: 0,
      latest_event: null,
    });
    const betaSpace: RoomListItemView = summary({
      ...alphaSpace,
      room_id: '!beta:example.test',
      name: 'Beta',
    });
    const gammaSpace: RoomListItemView = summary({
      ...alphaSpace,
      room_id: '!gamma:example.test',
      name: 'Gamma',
    });
    const successorRoom: RoomListItemView = summary({
      ...room,
      room_id: '!successor:example.test',
      name: 'Successor',
      unread: 0,
      notifying: 0,
      highlight: 0,
    });
    const tombstonedRoom: RoomListItemView = summary({
      ...room,
      room_id: '!tombstoned:example.test',
      name: 'Old Room',
      is_tombstoned: true,
      unread: 0,
      notifying: 0,
      highlight: 0,
    });
    const voiceRoom: RoomListItemView = summary({
      ...room,
      room_id: '!voice:example.test',
      name: 'Hangout',
      room_kind: 'voice',
      unread: 0,
      notifying: 0,
      highlight: 0,
    });
    const joinedRooms: RoomListItemView[] =
      workerMode === 'voice'
        ? [room, secondRoom, invitedRoom, voiceRoom]
        : workerMode === 'spaces'
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
      room_kind: 'text',
      num_joined_members: 3,
      join_rule: 'public',
      allowed_room_ids: [],
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
      via: [],
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
            room_kind: 'space',
            children: alphaChildren,
          }),
          hierarchyRoom('!nested:example.test', 'Nested', { room_kind: 'space' }),
          hierarchyRoom('!refused:example.test', 'Refused Space', { room_kind: 'space' }),
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
            room_kind: 'space',
            children: [childEdge('!deep:example.test', 1)],
          }),
          hierarchyRoom('!deep:example.test', 'Deep Room'),
        ],
        next_batch: null,
      },
    };

    const CHILD_ORDER_KEY = 'e2e-space-child-order';
    const recordChildOrder = (command: RpcParams<Rpc['spaces']['setChildOrder']>): void => {
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
    const abbreviations = new Map<string, AbbreviationView[]>();
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

    const timelineItems = (roomName: string, offset = 0): TimelineItemView[] =>
      Array.from(
        { length: workerMode === 'forward_history' || workerMode === 'unread_catchup' ? 80 : 20 },
        (_, relativeIndex) => {
          const index = offset + relativeIndex;
          return {
            id: `${roomName.toLowerCase()}-${String(index)}`,
            row: 'message',
            forwardable: true,
            redactable: true,
            visibility: 'always',
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
              jumbo: null,
            },
            in_reply_to: null,
            thread_root: null,
            thread_summary: null,
            reactions: [],
            is_own: false,
            read_by: [],
            read_timestamps: {},
            per_message_profile: null,
            bundled_link_previews: [],
            link_previews_removed: null,
            mention: 'none',
            forwarded: null,
            forum_title: null,
          };
        }
      );

    const searchHits = (payload: RpcParams<Rpc['search']['messages']>) => {
      const query = payload.query.toLowerCase();
      const filter = payload.filter;
      const offset = payload.offset;
      const newestFirst = payload.order === 'recent';

      return [room, secondRoom]
        .filter(
          (candidate) =>
            (!filter?.rooms.length || filter.rooms.includes(candidate.room_id)) &&
            !filter?.not_rooms.includes(candidate.room_id)
        )
        .flatMap((candidate) =>
          timelineItems(candidate.name ?? '')
            .filter((item) => {
              if (item.content.kind !== 'message') return false;
              const body = item.content.body.toLowerCase();
              if (query !== '' && !query.split(/\s+/).every((word) => body.includes(word)))
                return false;
              if (!filter) return true;
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
              context_before: [],
              context_after: [],
            }))
        )
        .sort((left, right) => (newestFirst ? right.origin_server_ts - left.origin_server_ts : 0))
        .slice(offset, offset + payload.limit);
    };

    const rooms = new Map<string, RoomListItemView>([
      [room.room_id, room],
      [secondRoom.room_id, secondRoom],
      [invitedRoom.room_id, invitedRoom],
      [tombstonedRoom.room_id, tombstonedRoom],
      [successorRoom.room_id, successorRoom],
      [voiceRoom.room_id, voiceRoom],
      [alphaSpace.room_id, alphaSpace],
      [betaSpace.room_id, betaSpace],
      [gammaSpace.room_id, gammaSpace],
    ]);
    let nextSubscription = 2;
    const ONBOARDING_KEY = 'sable-e2e-onboarding';
    const onboarded = JSON.parse(sessionStorage.getItem(ONBOARDING_KEY) ?? 'null') as {
      signedOut: boolean;
      identityConfirmed: boolean;
      accountData: [string, unknown][];
    } | null;
    let signedOut = onboarded?.signedOut ?? workerMode === 'onboarding';
    let identityConfirmed = onboarded?.identityConfirmed ?? workerMode !== 'onboarding';
    const accountData = new Map<string, unknown>(onboarded?.accountData ?? []);
    const saveOnboarding = () => {
      if (workerMode !== 'onboarding') return;
      sessionStorage.setItem(
        ONBOARDING_KEY,
        JSON.stringify({ signedOut, identityConfirmed, accountData: [...accountData] })
      );
    };
    const encryption = (): EncryptionStatusView => ({
      verification: identityConfirmed ? 'verified' : 'unverified',
      recovery: identityConfirmed ? 'enabled' : 'disabled',
      cross_signing_ready: identityConfirmed,
      backup_unlocked: identityConfirmed,
      signing_keys: {
        master: identityConfirmed,
        self_signing: identityConfirmed,
        user_signing: identityConfirmed,
      },
      recovery_passphrase: false,
      account_data_key: false,
    });
    const subscriptions = new Map<
      number,
      { roomId: string; page: number; live: boolean; thread: boolean; oldest: number }
    >();
    const arrivals: TimelineItemView[] = [];
    let unreadContextOpened = false;
    const notificationKeywords: KeywordNotificationView[] = [];
    let defaultGroupMode: 'all' | 'mentions' = 'mentions';
    const eventNotifications: EventNotificationsView = {
      membership: false,
      reactions: false,
      edits: false,
      notices: false,
      invites: true,
      calls: true,
    };
    let masterMute: boolean | null = false;
    const mentionNotificationModes: MentionNotificationsView = {
      room: 'notify',
      user: 'loud',
      display_name: 'loud',
      username: 'loud',
    };
    let activePort: FakePort | null = null;

    const servedBytes = new Map<string, Promise<Uint8Array>>();
    function servedPng(source: string): Promise<Uint8Array> {
      if (source.includes('undecodable-')) return Promise.resolve(new Uint8Array([0, 1, 2, 3]));
      if (source.includes('.pdf')) {
        return Promise.resolve(
          new TextEncoder().encode(
            '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
          )
        );
      }
      const [width, height] = source.includes('spoiler-preview')
        ? [800, 600]
        : source.includes('wide-')
          ? [1000, 400]
          : [80, 60];
      const key = `${String(width)}x${String(height)}`;
      let bytes = servedBytes.get(key);
      if (bytes === undefined) {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        if (context && source.includes('spoiler-preview')) {
          for (const [index, color] of ['#328cab', '#dfb36d', '#43614a'].entries()) {
            context.fillStyle = color;
            context.fillRect(0, (height * index) / 3, width, height / 3);
          }
          context.fillStyle = '#f7e5bd';
          context.beginPath();
          context.arc(width * 0.75, height * 0.2, height * 0.1, 0, Math.PI * 2);
          context.fill();
        }
        bytes = canvas
          .convertToBlob({ type: 'image/png' })
          .then((blob) => blob.arrayBuffer())
          .then((buffer) => new Uint8Array(buffer));
        servedBytes.set(key, bytes);
      }
      return bytes;
    }

    const subscriptionRoom = (subscription: number): RoomListItemView => {
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
        row: 'annotation',
        forwardable: false,
        redactable: false,
        visibility: 'always',
      };
      const readMarker: TimelineItemView = {
        ...first,
        id: `${roomName.toLowerCase()}-read-marker`,
        event_id: null,
        sender: null,
        sender_name: null,
        content: { kind: 'read_marker' },
        row: 'annotation',
        forwardable: false,
        redactable: false,
        visibility: 'always',
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
              jumbo: null,
            },
          }));
        case 'delayed_pagination':
          return [timelineStart, ...items];
        case 'unread':
          return [...items.slice(0, 5), readMarker, ...items.slice(5)];
        case 'unread_history':
        case 'unread_context_error':
          return timelineItems(roomName, 9_980);
        case 'unread_catchup':
          return [...items.slice(60), ...arrivals];
        case 'forward_history':
          return items.slice(0, 5);
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
      jumbo: null,
    });

    const paginationDiffs = (
      roomName: string,
      page: number
    ): Extract<CoreEvent, { type: 'timeline_diff' }>['diffs'] => {
      const items = timelineItems(roomName);
      const first = items[0];
      switch (workerMode) {
        case 'unread_history': {
          if (page > 1) return [];
          const marker: TimelineItemView = {
            ...first,
            id: `${roomName.toLowerCase()}-read-marker`,
            event_id: null,
            sender: null,
            sender_name: null,
            content: { kind: 'read_marker' },
            row: 'annotation',
            forwardable: false,
            redactable: false,
            visibility: 'always',
          };
          return [...items.slice(0, 5), marker, ...items.slice(5, 10)].map((value, index) => ({
            op: 'insert' as const,
            index,
            value,
          }));
        }
        case 'empty_room':
          return [];
        case 'endless_history':
          return Array.from({ length: 20 }, (_, index) => ({
            op: 'insert',
            index,
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

    let backupDownload: KeyBackupDownloadView | null = null;

    const fullyReadEventId = (roomId: string): string =>
      `$${(joinedRooms.find((room) => room.room_id === roomId)?.name ?? 'General').toLowerCase()}-${workerMode === 'unread' || workerMode === 'unread_history' || workerMode === 'unread_context_error' || workerMode === 'unread_catchup' ? '4' : '19'}:example.test`;
    const roomStateEvents = (roomId: string, eventType: string) => {
      const content =
        eventType === 'im.vector.modular.widgets' ? roomWidgets.get(roomId) : undefined;
      return content ? [{ state_key: WIDGET_STATE_KEY, content }] : [];
    };

    const roomPermissions = (roomId: string) => {
      const canPost = roomId !== secondRoom.room_id;
      return {
        own_power_level: canPost ? 100 : 0,
        can_post: canPost,
        can_react: canPost,
        can_redact_own: canPost,
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
    };

    const rpcHandlers: RpcHandlers = {
      'auth.discover_homeserver': () => 'https://example.test',
      'auth.login': () => {
        signedOut = false;
        saveOnboarding();
        return session.user_id;
      },
      'auth.login_flows': () => ({
        password: true,
        oidc: false,
        oidc_registration: false,
        qr_login: false,
        sso: false,
        oauth_aware_preferred: false,
        sso_identity_providers: [],
      }),
      'auth.registration_flows': () => ({
        uiaa: true,
        email: 'unavailable',
        registration_token: 'unavailable',
      }),
      'auth.register': () => ({ state: 'complete', user_id: session.user_id }),
      'auth.continue_registration': () => ({ state: 'complete', user_id: session.user_id }),
      'auth.request_registration_email': () => ({ state: 'complete', user_id: session.user_id }),
      'auth.submit_registration_email': () => ({ state: 'complete', user_id: session.user_id }),
      'auth.request_password_reset_email': (params) => ({
        client_secret: params.client_secret ?? 'fake-secret',
        sid: 'fake-sid',
      }),
      'auth.start_oidc_login': () => 'https://example.test/authorize',
      'auth.complete_oidc_login': () => session.user_id,
      'auth.start_sso_login': () => 'https://example.test/sso',
      'auth.complete_sso_login': () => session.user_id,
      'encryption.status': () => encryption(),
      'encryption.key_backup_status': () => ({
        local_keys: backupDownload?.state === 'complete' ? 200 : 120,
        backed_up_keys: backupDownload?.state === 'complete' ? 200 : 120,
        cloud_keys: 200,
        can_restore: true,
        download: backupDownload,
      }),
      'encryption.download_key_backup': (params) => {
        backupDownload = {
          account_id: session.account_id,
          request_id: params.request_id,
          state: 'complete',
          total: 200,
          processed: 200,
          imported: 80,
          failed: 0,
        };
        return backupDownload;
      },
      'encryption.sign_out_safety': () => ({
        encryption: {
          verification: workerMode === 'unverified' ? 'unverified' : 'verified',
          recovery: 'enabled',
          cross_signing_ready: true,
          backup_unlocked: true,
          signing_keys: { master: true, self_signing: true, user_signing: true },
          recovery_passphrase: false,
          account_data_key: false,
        },
        backup_enabled: true,
        backup_uploaded: true,
        has_encrypted_rooms: true,
      }),
      'encryption.devices': () => ({
        account_management: false,
        oauth: false,
        devices: [
          {
            device_id: session.device_id,
            display_name: 'This browser',
            is_verified: identityConfirmed,
            has_keys: true,
            cross_signed: identityConfirmed,
            is_own: true,
            last_seen_ts: null,
            last_seen_ip: null,
          },
          {
            device_id: 'PHONE',
            display_name: 'Phone',
            is_verified: false,
            has_keys: true,
            cross_signed: false,
            is_own: false,
            last_seen_ts: null,
            last_seen_ip: null,
          },
        ],
      }),
      'encryption.user_security': (params) => ({
        verification: params.user_id === '@alice:example.org' ? 'verified' : 'unverified',
        verification_violation: false,
        devices: [
          {
            device_id: 'PHONE',
            display_name: 'Phone',
            verified: true,
            cross_signed: true,
            blocked: false,
          },
        ],
      }),
      'encryption.enable_recovery': () => 'e2e-recovery-key',
      'encryption.reset_recovery_key': () => 'e2e-recovery-key',
      'encryption.reset_identity': (_params, port) => {
        if (workerMode === 'onboarding') {
          identityConfirmed = true;
          saveOnboarding();
          window.setTimeout(() => {
            port.emit({ type: 'encryption_status', status: encryption() });
          }, 50);
        }
        return { step: 'done', recovery_key: 'e2e-recovery-key' };
      },
      'encryption.continue_identity_reset': () => 'e2e-recovery-key',
      'encryption.export_room_keys': () => {
        throw new FakeCoreError('unsupported');
      },
      'encryption.import_room_keys': () => {
        throw new FakeCoreError('unsupported');
      },
      'encryption.delete_device': () => null,
      'encryption.request_verification': () => 'e2e-flow',
      'account.user_profile': (params) => {
        const localpart = params.user_id.replace(/^@/, '').split(':')[0];
        return {
          ...profile,
          user_id: params.user_id,
          display_name:
            params.user_id === profile.user_id
              ? profile.display_name
              : `${localpart.charAt(0).toUpperCase()}${localpart.slice(1)}`,
          ...(window as { __e2eProfilePatch?: Partial<ProfileView> }).__e2eProfilePatch,
        };
      },
      'account.set_profile_field': () => {
        if (window.__e2eProfileSaveError) throw new FakeCoreError('unavailable');
        return null;
      },
      'account.user_relations': () => ({ mutual_rooms: [], ignored: false }),
      'account.contacts': () => [],
      'account.ignored_users': () => [],
      'account.invite_triage': () => [],
      'account.data_types': () => [],
      'account.data': (params) => accountData.get(params.event_type) ?? null,
      'account.set_data': (params) => {
        if (workerMode === 'onboarding') accountData.set(params.event_type, params.content);
        saveOnboarding();
        return null;
      },
      'account.sealed_data': (params) => ({
        content: accountData.get(params.event_type) ?? null,
        state: 'plain',
        can_seal: false,
      }),
      'account.set_sealed_data': (params) => {
        if (workerMode === 'onboarding') accountData.set(params.event_type, params.content);
        saveOnboarding();
        return null;
      },
      'account.bookmarks': () => readBookmarks(),
      'account.set_bookmark': (params) => {
        const entries = readBookmarks().filter(
          (entry) => !(entry.room_id === params.room_id && entry.event_id === params.event_id)
        );
        if (params.bookmarked) {
          const bookmarkedRoom = rooms.get(params.room_id);
          const item = bookmarkedRoom
            ? timelineItems(bookmarkedRoom.name ?? '').find(
                (candidate) => candidate.event_id === params.event_id
              )
            : undefined;
          entries.push({
            bookmark_id: `${params.room_id}|${params.event_id}`,
            room_id: params.room_id,
            event_id: params.event_id,
            room_name: bookmarkedRoom?.name ?? null,
            sender: item?.sender ?? null,
            body_preview: item?.content.kind === 'message' ? item.content.body : null,
            event_ts: item?.timestamp ?? params.now_ms,
            bookmarked_ts: params.now_ms,
          });
        }
        writeBookmarks(entries);
        return params.bookmarked;
      },
      'account.search_user_directory': () => ({ limited: false, results: [] }),
      'account.media_preview_config': () => ({ media_previews: null, invite_avatars: null }),
      'account.set_media_preview_config': (params) => params.config,
      'account.profile_overrides': () => ({ overrides: [], protection: 'plain', can_seal: false }),
      'account.set_profile_override': () => ({
        overrides: [],
        protection: 'plain',
        can_seal: false,
      }),
      'account.dismissed_invites': () => [],
      'account.set_invite_dismissed': (params) => (params.dismissed ? [params.room_id] : []),
      'messages.send': (params) => {
        if (window.__e2eSendError) throw new FakeCoreError(window.__e2eSendError);
        receiveMessage(params.body, true);
        return null;
      },
      'messages.edit': () => null,
      'messages.markdown_to_content': (params) => ({
        body: params.markdown,
        formatted_body: null,
        mentions: { user_ids: [], room: false },
      }),
      'messages.bulk_redact': () => 0,
      'messages.delete_thread': () => null,
      'messages.reaction_shortcodes': () => [],
      'calendar.entries': () => ({ entries: [], rsvps: [] }),
      'messages.url_preview': (params) =>
        params.url === 'https://example.test/article'
          ? {
              url: params.url,
              title: 'The Example Article',
              description: 'A short description of the article.',
              site_name: 'Example',
              image: null,
              image_mime: null,
              image_width: null,
              image_height: null,
              video: null,
              theme_color: null,
              card: null,
              author_name: null,
            }
          : null,
      'messages.schedule': () => 'e2e-delay',
      'messages.schedule_attachment': () => 'e2e-attachment',
      'messages.scheduled': () => [],
      'messages.media_config': () => ({ upload_size: 100 * 1024 * 1024 }),
      'messages.cancel_send': () => true,
      'messages.send_gesture': () => null,
      'calendar.answer_event': () => null,
      'messages.send_raw_event': () => `$message-${crypto.randomUUID()}`,
      'messages.send_redaction': () => `$redaction-${crypto.randomUUID()}`,
      'notifications.settings': () => ({ room: null, default: 'all' }),
      'notifications.default_modes': () => ({
        direct: 'all',
        group: defaultGroupMode,
      }),
      'notifications.mention_notifications': () => mentionNotificationModes,
      'notifications.event_notifications': () => eventNotifications,
      'notifications.master_mute': () => masterMute,
      'notifications.notification': () => null,
      'notifications.keywords': () => notificationKeywords.map((entry) => ({ ...entry })),
      'notifications.push_event': () => ({ kind: 'unavailable' }),
      'notifications.inbox': (params) => {
        const items = [
          {
            room_id: room.room_id,
            event_id: '$general-19:example.test',
            ts: 1_700_000_000_019,
            sender: '@alice:example.test',
            sender_name: 'Alice',
            body: 'General message 19',
            highlight: true,
            is_direct: false,
            encrypted: true,
            read: false,
          },
          {
            room_id: secondRoom.room_id,
            event_id: '$random-3:example.test',
            ts: 1_700_000_000_010,
            sender: '@a-very-long-localpart-for-a-bot-account:example.test',
            sender_name: null,
            body: null,
            highlight: false,
            is_direct: false,
            encrypted: true,
            read: true,
          },
        ].filter(
          (item) =>
            (params.include_read || !item.read) &&
            (params.filter !== 'mentions' || item.highlight) &&
            (params.filter !== 'direct' || item.is_direct)
        );
        return { items, has_more: false };
      },
      'notifications.backfill_inbox': () => ({ recorded: 0, has_more: false }),
      'notifications.add_keyword': (params) => {
        if (params.keyword === 'network-fail') throw new FakeCoreError('failed');
        const existing = notificationKeywords.find((entry) => entry.keyword === params.keyword);
        if (existing) existing.mode = 'notify';
        else notificationKeywords.push({ keyword: params.keyword, mode: 'notify' });
        return null;
      },
      'notifications.remove_keyword': (params) => {
        if (params.keyword === 'stuck-keyword') throw new FakeCoreError('failed');
        const index = notificationKeywords.findIndex((entry) => entry.keyword === params.keyword);
        if (index !== -1) notificationKeywords.splice(index, 1);
        return null;
      },
      'notifications.set_keyword_mode': (params) => {
        const existing = notificationKeywords.find((entry) => entry.keyword === params.keyword);
        if (existing) existing.mode = params.mode;
        return null;
      },
      'notifications.set_mention_notifications': (params) => {
        mentionNotificationModes[params.rule] = params.mode;
        return null;
      },
      'notifications.set_default_mode': (params) => {
        if (!params.direct && (params.mode === 'all' || params.mode === 'mentions'))
          defaultGroupMode = params.mode;
        return null;
      },
      'notifications.set_event_notification': (params) => {
        eventNotifications[params.event] = params.enabled;
        return null;
      },
      'notifications.set_master_mute': (params) => {
        masterMute = params.muted;
        return null;
      },
      'push.web_pusher_support': () => null,
      'push.web_pushers': () => [],
      'push.ping_gateway': () => null,
      'push.send_diagnostic': () => ({ kind: 'no_pusher' }),
      'push.discover_gateway': () => null,
      'session.restore': () => {
        if (workerMode === 'loading') return NO_REPLY;
        if (workerMode === 'error') throw new FakeCoreError('failed');
        return signedOut ? null : session;
      },
      'session.logout': () => {
        signedOut = true;
        return null;
      },
      'session.list_accounts': () => (signedOut ? [] : (window.__e2eAccounts ?? [session])),
      'session.switch_account': () => {
        if (window.__e2eSwitchAccountError) throw new FakeCoreError('unavailable');
        return session;
      },
      'session.request_open_id_token': () => ({
        access_token: 'e2e-openid-token',
        matrix_server_name: 'example.test',
        expires_in: 3600,
      }),
      'session.homeserver_info': () => ({
        homeserver: 'https://example.test',
        server: { name: 'Sable Test', version: '1.0' },
      }),
      'session.access_token': () => 'e2e-access-token',
      'session.open_id_token': () => ({
        access_token: 'e2e-openid',
        token_type: 'Bearer',
        matrix_server_name: 'example.test',
        expires_in_ms: 3_600_000,
      }),
      'session.sync_status': () => ({ state: 'live' }),
      'session.server_features': () => [],
      'session.delayed_events_supported': () => true,
      'session.known_rooms': () => [],
      'session.integration_manager_terms': () => [],
      'session.integration_manager_url': () => 'https://integrations.example.test/index.html',
      'search.messages': (params) => ({ hits: searchHits(params), older: null }),
      'search.coverage': () => ({
        documents: 0,
        rooms_pending: 0,
        rooms_failed: 0,
        state: 'complete',
      }),
      'search.metrics': () => ({
        phase: 'idle',
        documents: 0,
        documents_loaded: 0,
        memory_bytes: 0,
        memory_budget: 67108864,
        disk_bytes: 0,
        disk_budget: 536870912,
        rooms_joined: 0,
        rooms_indexed: 0,
        rooms_pending: 0,
        rooms_exhausted: 0,
        rooms_failed: 0,
        rooms_blind: 0,
        rooms_unreadable: 0,
        events_crawled: 0,
        event_budget: 20000,
        batches: 0,
        pushbacks: 0,
        last_request_ms: null,
        average_request_ms: null,
        running_ms: null,
      }),
      'calls.join': () => ({
        session: 1,
        url: 'wss://sfu.example.test',
        jwt: 'e2e-jwt',
        identity: `${session.user_id}:${session.device_id}`,
        encrypt_media: false,
        mode: 'legacy',
        mode_reason: 'fresh',
        sticky_available: false,
        peer_modes: [],
        can_publish: true,
        publisher_id: 'legacy',
        backends: [
          {
            id: 'legacy',
            url: 'wss://sfu.example.test',
            jwt: 'e2e-jwt',
            identity: `${session.user_id}:${session.device_id}`,
          },
        ],
      }),
      'calls.compatibility': () => ({
        sticky_events: false,
        delayed_events: false,
        rtc_transports: 'none',
      }),
      'calls.support': () => ({ has_focus: false, can_join: false }),
      'calls.turn_server': () => ({
        username: 'e2e',
        password: 'e2e',
        uris: [],
        ttl_ms: 3_600_000,
      }),
      'calls.rtc_transports': () => ({ rtc_transports: [] }),
      'calls.rtc_livekit': () => ({}),
      'widgets.send_delayed_event': () => 'e2e-widget-delay',
      'widgets.send_sticky_event': () => '$e2e-widget-sticky',
      'widgets.room_sticky_events': () => [],
      'timeline.subscribe_room_list': () => ({
        subscription: 1,
        rooms: joinedRooms,
      }),
      'timeline.subscribe': (params) => {
        const focus = params.focus ?? { kind: 'live' };
        window.__e2eTimelineFocus.push(focus);
        if (
          workerMode === 'thread_error' &&
          focus.kind === 'thread' &&
          window.__e2eTimelineFocus.filter((focus) => focus.kind === 'thread').length === 1
        ) {
          throw new FakeCoreError('load_failed');
        }
        if (workerMode === 'unread_context_error' && focus.kind === 'event') {
          throw new FakeCoreError('load_failed');
        }
        const subscription = nextSubscription++;
        subscriptions.set(subscription, {
          roomId: params.room_id,
          page: 0,
          live: focus.kind === 'live',
          thread: focus.kind === 'thread',
          oldest: workerMode === 'unread_catchup' ? 60 : 0,
        });
        timelineRooms.push(params.room_id);
        timelineSubscriptions.push(subscription);
        const roomName = subscriptionRoom(subscription).name ?? '';
        const items = timelineItems(roomName);
        const unreadContext =
          (workerMode === 'unread_history' || workerMode === 'unread_catchup') &&
          focus.kind === 'event';
        if (unreadContext) unreadContextOpened = true;
        const marker: TimelineItemView = {
          ...items[0],
          id: `${roomName.toLowerCase()}-read-marker`,
          event_id: null,
          sender: null,
          sender_name: null,
          content: { kind: 'read_marker' },
          row: 'annotation',
          forwardable: false,
          redactable: false,
          visibility: 'always',
        };
        return {
          subscription,
          items: unreadContext
            ? [...items.slice(0, 5), marker, ...items.slice(5, 20)]
            : workerMode === 'thread_links' && focus.kind === 'thread'
              ? [
                  { ...items[0], id: 'thread-root', event_id: '$thread-root:example.test' },
                  ...Array.from({ length: 40 }, (_, index) => ({
                    ...items[0],
                    id: `thread-reply-${index}`,
                    event_id: `$thread-reply-${index}:example.test`,
                    content: messageContent(`Thread reply ${index}`),
                    thread_root: '$thread-root:example.test',
                  })),
                ]
              : workerMode === 'thread_links' &&
                  focus.kind === 'event' &&
                  focus.event_id === '$thread-reply-older:example.test'
                ? [
                    { ...items[0], id: 'thread-root', event_id: '$thread-root:example.test' },
                    {
                      ...items[0],
                      id: 'thread-reply-older',
                      event_id: '$thread-reply-older:example.test',
                      content: messageContent('Older thread reply'),
                      thread_root: '$thread-root:example.test',
                    },
                    ...Array.from({ length: 5 }, (_, index) => ({
                      ...items[0],
                      id: `thread-reply-${index}`,
                      event_id: `$thread-reply-${index}:example.test`,
                      content: messageContent(`Thread reply ${index}`),
                      thread_root: '$thread-root:example.test',
                    })),
                  ]
                : timelineSnapshot(roomName),
          aggregations: [],
        };
      },
      'timeline.unsubscribe': (params) => {
        subscriptions.delete(params.subscription);
        return null;
      },
      'timeline.paginate': (params, port) => {
        window.__e2ePaginationDirections.push(params.direction);
        const state = subscriptions.get(params.subscription);
        if (!state) throw new Error('unknown timeline subscription');
        const paginated = subscriptionRoom(params.subscription);
        const roomName = paginated.name ?? '';
        if (workerMode === 'thread_links' && state.thread) {
          window.setTimeout(() => {
            port.emit({
              type: 'timeline_diff',
              subscription: params.subscription,
              diffs: [
                {
                  op: 'insert',
                  index: 1,
                  value: {
                    ...timelineItems(roomName)[0],
                    id: 'thread-reply-older',
                    event_id: '$thread-reply-older:example.test',
                    content: messageContent('Older thread reply'),
                    thread_root: '$thread-root:example.test',
                  },
                },
              ],
            });
          }, 750);
          return { direction: params.direction, reached_end: true };
        }
        if (workerMode === 'unread_catchup') {
          const items = timelineItems(roomName);
          if (params.direction === 'backward') {
            const previous = state.oldest;
            state.oldest = Math.max(0, previous - 20);
            port.emit({
              type: 'timeline_diff',
              subscription: params.subscription,
              diffs: items
                .slice(state.oldest, previous)
                .map((value, index) => ({ op: 'insert' as const, index, value })),
            });
            return {
              direction: params.direction,
              reached_end: state.oldest === 0,
            };
          }
          state.page += 1;
          if (state.page === 3) {
            arrivals.push({
              ...items[79],
              id: 'during-handoff',
              event_id: '$during-handoff:example.test',
              content: messageContent('Arrived during handoff'),
            });
          }
          window.setTimeout(() => {
            port.emit({
              type: 'timeline_diff',
              subscription: params.subscription,
              diffs: [
                { op: 'append', values: items.slice(state.page * 20, (state.page + 1) * 20) },
              ],
            });
          }, 50);
          return { direction: params.direction, reached_end: state.page >= 3 };
        }
        if (workerMode === 'unread_history' || workerMode === 'unread_context_error') {
          if (params.direction === 'backward') {
            throw new FakeCoreError('load_failed');
          }
          state.page += 1;
          const values = timelineItems(roomName, state.page * 20);
          port.emit({
            type: 'timeline_diff',
            subscription: params.subscription,
            diffs: [{ op: 'append', values }],
          });
          return { direction: params.direction, reached_end: false };
        }
        if (workerMode === 'forward_history') {
          if (params.direction === 'backward') {
            return { direction: params.direction, reached_end: true };
          }
          state.page += 1;
          const page = state.page;
          const items = timelineItems(roomName);
          const values =
            page === 1
              ? [
                  {
                    ...items[4],
                    id: 'filtered-forward',
                    event_id: '$filtered-forward:example.test',
                    row: 'event' as const,
                    forwardable: false,
                    redactable: true,
                    visibility: 'profile_change' as const,
                    content: {
                      kind: 'profile_change' as const,
                      user_id: '@alice:example.test',
                      display_name: { old: 'Alice', new: 'Alicia' },
                      avatar: null,
                    },
                  },
                ]
              : items.slice((page - 1) * 5, page * 5);
          window.setTimeout(() => {
            port.emit({
              type: 'timeline_diff',
              subscription: params.subscription,
              diffs: values.map((value) => ({ op: 'push_back' as const, value })),
            });
          }, 250);
          return { direction: params.direction, reached_end: page >= 16 };
        }
        state.page += 1;
        const page = state.page;
        const reachedEnd =
          workerMode === 'endless_history'
            ? false
            : workerMode === 'empty_room' || workerMode === 'delayed_history' || page >= 2;
        port.emit({
          type: 'timeline_pagination',
          subscription: params.subscription,
          loading: true,
          reached_start: false,
        });
        window.setTimeout(() => {
          port.emit({
            type: 'timeline_diff',
            subscription: params.subscription,
            diffs: paginationDiffs(roomName, page),
          });
          port.emit({
            type: 'timeline_pagination',
            subscription: params.subscription,
            loading: false,
            reached_start: reachedEnd,
          });
        }, paginationDelay());
        return { direction: params.direction, reached_end: reachedEnd };
      },
      'timeline.event_items': (params) => {
        const room = rooms.get(params.room_id);
        const items = room ? timelineItems(room.name ?? '') : [];
        return params.event_ids.flatMap((eventId) =>
          items.filter((candidate) => candidate.event_id === eventId)
        );
      },
      'timeline.events': () => [],
      'timeline.timestamp_to_event': () => null,
      'timeline.list_threads': () => ({ roots: [], next_batch: null }),
      'timeline.event_source': (params) => ({
        source:
          workerMode === 'thread_links' && params.event_id.startsWith('$thread-reply-')
            ? JSON.stringify({
                type: 'm.room.message',
                content: {
                  'm.relates_to': { rel_type: 'm.thread', event_id: '$thread-root:example.test' },
                },
              })
            : params.event_id === '$edit:example.test'
              ? JSON.stringify({
                  type: 'm.room.message',
                  content: {
                    'm.relates_to': { rel_type: 'm.replace', event_id: '$general-8:example.test' },
                  },
                })
              : '{}',
        encrypted: false,
        original: null,
      }),
      'timeline.edit_history': () => [],
      'timeline.read_marker': (params) => fullyReadEventId(params.room_id),
      'timeline.room_event_relations': () => ({
        chunk: window.__e2eRelationEvents ?? [],
        next_batch: null,
        prev_batch: null,
      }),
      'timeline.pinned_events': () => [],
      'timeline.set_pinned': () => [],
      'timeline.pin_read_state': () => ({
        pinned_ids: [],
        unread: 0,
        fresh_ids: [],
      }),
      'timeline.mark_pins_seen': (params) => ({
        pinned_ids: params.pinned_ids,
        unread: 0,
        fresh_ids: [],
      }),
      'spaces.set_child_order': (params) => {
        recordChildOrder(params);
        return null;
      },
      'spaces.hierarchy': (params) => {
        if (params.space_id === '!refused:example.test') throw new FakeCoreError('failed');
        const page = hierarchyPages[`${params.space_id}|${params.from ?? ''}`] ?? {
          rooms: [],
          next_batch: null,
        };
        return { rooms: page.rooms, next_batch: page.next_batch };
      },
      'spaces.sidebar': () => readSidebar(),
      'spaces.set_sidebar': (params, port) => {
        sessionStorage.setItem(SIDEBAR_KEY, JSON.stringify(params.items));
        window.setTimeout(() => {
          port.emit({ type: 'space_sidebar_changed', items: params.items });
        });
        return null;
      },
      'spaces.room_has_space_parent': () => false,
      'spaces.unjoined_space_parents': () => [],
      'packs.list': () => ({
        packs: (window as { __e2eImagePacks?: ImagePackView[] }).__e2eImagePacks ?? [],
        complete: true,
      }),
      'packs.list_all': () => [],
      'packs.create_room_pack': () => 'pack',
      'packs.subscriptions': () => [],
      'packs.set_subscriptions': (params) => params.added,
      'personas.list': () => ({ personas: [], account: null, rooms: {}, disabled_rooms: [] }),
      'personas.save': () => [],
      'personas.remove': () => [],
      'personas.reorder': () => [],
      'personas.backup': () => '{}',
      'room_state.event': (params) =>
        params.event_type === 'moe.sable.room.abbreviations'
          ? { entries: abbreviations.get(params.room_id) ?? [] }
          : params.event_type === 'm.room.tombstone' && params.room_id === tombstonedRoom.room_id
            ? { replacement_room: successorRoom.room_id, body: null }
            : null,
      'room_state.events': (params) => roomStateEvents(params.room_id, params.event_type),
      'room_state.bot_commands': () => [],
      'room_state.account_data': (params) =>
        params.event_type === 'm.fully_read'
          ? { event_id: fullyReadEventId(params.room_id) }
          : null,
      'room_state.events_raw': () => [],
      'room_state.full_state': () => [],
      'room_state.account_data_raw': () => null,
      'room_state.account_data_types': () => [],
      'room_state.send_event': (params) => {
        if (params.event_type === 'im.vector.modular.widgets')
          roomWidgets.set(params.room_id, null);
        return `$state-${crypto.randomUUID()}`;
      },
      'room_state.add_widget': () => 'widget',
      'room_state.history_visibility': () => 'shared',
      'room_state.banner': () => null,
      'room_state.member_list_threshold': () => null,
      'room_state.abbreviations': (params) => abbreviations.get(params.room_id) ?? [],
      'room_state.set_abbreviations': (params) => {
        abbreviations.set(params.room_id, params.entries);
        return null;
      },
      'members.list': () =>
        window.__e2eMembers ?? [
          {
            user_id: '@alice:example.test',
            display_name: 'Alice',
            avatar_url:
              (window as { __e2eProfilePatch?: Partial<ProfileView> }).__e2eProfilePatch
                ?.avatar_url ?? null,
            power_level: 100,
            membership: 'join',
            member_ts: null,
            kicked: false,
            service: false,
          },
        ],
      'members.permissions': (params) => roomPermissions(params.room_id),
      'members.power_levels': () => ({
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
      'members.set_power_level': (params) => ({
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
        ...params.levels,
      }),
      'members.sync_power_levels_from_space': () => ({
        levels: {
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
        },
        tags: {},
      }),
      'members.sync_child_power_levels': (params) => ({
        updated: params.child_ids.length,
        skipped: 0,
      }),
      'members.power_level_tags': () => ({}),
      'members.set_power_level_tag': () => ({}),
      'members.look': () => ({
        display_name: null,
        avatar_url: null,
        color_on_light: null,
        color_on_dark: null,
        pronouns: [],
      }),
      'rooms.replaced_rooms': () => [],
      'rooms.open': (params) => ({
        permissions: roomPermissions(params.room_id),
        power_level_tags: {},
        widgets: roomStateEvents(params.room_id, 'im.vector.modular.widgets'),
        pinned_event_ids: [],
        predecessor: null,
      }),
      'rooms.list_item': () => {
        throw new FakeCoreError('unknown_room');
      },
      'rooms.versions': () => ({
        default: '10',
        available: [
          { id: '10', stable: true },
          { id: '11', stable: true },
        ],
      }),
      'rooms.aliases': () => [],
      'rooms.public_rooms': () => ({ rooms: [], next_batch: null, total: 0 }),
      'rooms.directory_visibility': () => false,
      'rooms.upgrade': () => successorRoom.room_id,
      'rooms.attachments': () => ({ items: [], next_batch: null }),
      'rooms.cosmetics': () => ({ space_id: null, users: [] }),
      'rooms.create': () => '!created:example.test',
      'rooms.create_dm': () => '!dm:example.test',
      'rooms.preview': (params) => ({
        room_id: params.address,
        canonical_alias: null,
        name: 'Preview Room',
        topic: null,
        avatar_url: null,
        room_kind: 'text',
        num_joined_members: 3,
        join_rule: 'public',
        state: null,
        via: { type: 'unknown' },
      }),
      'rooms.join': (params) => params.address,
      'rooms.knock': (params) => params.address,
      'rooms.via_servers': () => ['example.test'],
      'rooms.canonical_alias': () => ({ alias: null, alt_aliases: [] }),
      'rooms.set_canonical_alias': (params) => ({
        alias: params.alias ?? null,
        alt_aliases: params.alt_aliases,
      }),
    };

    const replyDelay = (type: string, params: unknown): number => {
      if (type === 'session.switch_account') return window.__e2eSwitchAccountDelayMs ?? 0;
      if (workerMode === 'forward_history' && type === 'timeline.paginate') return 0;
      if (
        type === 'timeline.subscribe' &&
        workerMode === 'unread_catchup' &&
        ((params as RpcParams<Rpc['timeline']['subscribe']>).focus ?? { kind: 'live' }).kind ===
          'live' &&
        unreadContextOpened
      )
        return 1_500;
      if (type === 'timeline.paginate') return 500;
      if (
        type === 'timeline.subscribe' &&
        (workerMode === 'delayed_snapshot' || workerMode === 'delayed_history')
      )
        return 750;
      return 0;
    };

    class FakePort {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onmessageerror: ((event: MessageEvent) => void) | null = null;
      claim: (() => void) | null = null;

      start(): void {}

      close(): void {}

      emit(event: CoreEvent): void {
        this.onmessage?.({ data: { events: [event] } } as MessageEvent);
      }

      postMessage(request: {
        id: number;
        call?: { method: string; params: unknown };
        media?: { source: string; width: number; height: number };
        forget?: { source: string };
        reset?: true;
        runtime?: true;
        disconnect?: true;
      }): void {
        if (request.runtime || request.disconnect) return;
        this.claim?.();
        if (request.reset) {
          window.setTimeout(() => {
            this.onmessage?.({ data: { id: request.id, uri: null } } as MessageEvent);
          });
          return;
        }
        if (request.forget) {
          commandLog.push('forget_media');
          window.setTimeout(() => {
            this.onmessage?.({ data: { id: request.id, uri: null } } as MessageEvent);
          });
          return;
        }
        if (request.media) {
          const { source, width, height } = request.media;
          commandLog.push(`fetch_media ${String(width)}x${String(height)}`);
          window.setTimeout(
            () => {
              void Promise.resolve(window.__e2eMediaReady)
                .then(() => window.__e2eFetchMedia?.(source, width, height) ?? servedPng(source))
                .then((bytes) => {
                  this.onmessage?.({ data: { id: request.id, bytes } } as MessageEvent);
                });
            },
            workerMode === 'delayed_media' ? 1_000 : 100
          );
          return;
        }
        if (request.call) {
          const { method, params } = request.call;
          commandLog.push(method);
          calls.push(request.call);
          const handler = (
            rpcHandlers as Record<
              string,
              ((params: unknown, port: FakePort) => unknown) | undefined
            >
          )[method];
          let reply: { id: number; ok: unknown } | { id: number; err: { code: string } };
          try {
            const ok = handler ? handler(params, this) : null;
            if (ok === NO_REPLY) return;
            reply = { id: request.id, ok };
          } catch (error) {
            if (!(error instanceof FakeCoreError)) throw error;
            reply = { id: request.id, err: { code: error.code } };
          }
          window.setTimeout(
            () => {
              this.onmessage?.({ data: reply } as MessageEvent);
              if (method !== 'timeline.subscribe' || !('ok' in reply)) return;
              this.subscribed((reply.ok as RpcResult<Rpc['timeline']['subscribe']>).subscription);
            },
            replyDelay(method, params)
          );
          return;
        }
      }

      subscribed(subscription: SubscriptionId): void {
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
      }
    }

    Object.defineProperty(window, '__e2eEmitTimelineEvent', {
      configurable: true,
      value: (event: unknown) => activePort?.emit(event as CoreEvent),
    });
    function receiveMessage(body: string, own = false): void {
      const id = `live-arrival-${arrivals.length}`;
      const item: TimelineItemView = {
        ...timelineItems('General')[0],
        id,
        event_id: own ? null : `$${id}:example.test`,
        transaction_id: own ? id : null,
        sender: own ? session.user_id : '@alice:example.test',
        is_own: own,
        content: messageContent(body),
      };
      arrivals.push(item);
      for (const [subscription, state] of subscriptions) {
        if (state.roomId === room.room_id && state.live) {
          activePort?.emit({
            type: 'timeline_diff',
            subscription,
            diffs: [{ op: 'push_back', value: item }],
          });
        }
      }
    }
    Object.defineProperty(window, '__e2eReceiveMessage', {
      configurable: true,
      value: receiveMessage,
    });
    Object.defineProperty(window, '__e2eRefreshRoom', {
      configurable: true,
      value: () =>
        activePort?.emit({
          type: 'room_list_diff',
          subscription: 1,
          diffs: [{ op: 'set', index: 0, value: summary({ ...room, unread: room.unread + 1 }) }],
        }),
    });

    class FakeSharedWorker {
      port = new FakePort();

      constructor() {
        this.port.claim = () => {
          activePort = this.port;
        };
      }

      addEventListener(): void {}
    }

    Object.defineProperty(window, 'SharedWorker', {
      configurable: true,
      value: FakeSharedWorker,
    });
  }, mode);
}
