import type { MatrixLink } from '#lib/rooms/matrix-link.ts';
import type {
  EventPreview,
  HierarchyRoom,
  HierarchyRoomView,
  HierarchySection,
} from '#src/generated/protocol';

export function parseMatrixLink(href: string): MatrixLink | null {
  if (href.includes('matrix:roomid/') || href.includes('/#/#')) {
    {
      return { kind: 'room', room_id: '!foo' };
    }
  } else if (href.includes('matrix:u/') || href.includes('#/@')) {
    return { kind: 'user', user_id: '@example:matrix.org' };
  } else {
    return { kind: 'event', room_id: '!foo', event_id: 'foo' };
  }
}

export const proxyBody = () => null;
export const roomSpaces = () => [];
export const imageIsAnimated = () => false;
export const parseJoinAddress = (input: string) => {
  return {
    address: input,
    via: [],
  };
};
export const mentionUri = (input: string) => input;
export const canonicalDatetime = () => null;
export const splitVia = (href: string) => {
  return { href, via: [] };
};
export const isOpaqueMatrixColor = () => true;
export const normalizeMfmHex = () => undefined;
export const parseMfmColor = () => null;
export const parseMfmUnixtime = () => null;
export const parseZonedDatetime = () => {
  return { instant: 0, datetime: 'January 1, 1970 01:00' };
};
export const unixSecondsOf = () => null;
export const emoteRecents = () => {
  return { images: [], cells: [] };
};
export const invalidShortcode = () => null;
export const normalizeShortcode = (i: unknown) => i;
export const shortcodeWithoutExtension = (i: unknown) => i;
export const uniqueShortcode = (i: unknown) => i;
export const canSendState = () => true;
export const reactionKey = () => null;
export const eventPreview = () => {
  return {
    sender: 'Alice',
    body: 'Hello world!',
    fallback: null,
    emotes: [],
  } satisfies EventPreview;
};
export const layoutSpaceIds = () => [];
export const mergeSpaces = () => [];
export const withSpace = () => [];
export const withoutSpace = () => [];
export const orderedKnownSpaceIds = () => [];

export const rememberSpaceIds = () => [];
export const removeFromFolder = () => [];
export const renameFolder = () => [];
export const setFolderIcon = () => [];
export const ungroupFolder = () => [];
export const applyLayoutDrop = () => [];
export const buildHierarchySections = () => [
  {
    space: null,
    suggested: true,
    depth: 0,
    key: '',
    rooms: [
      {
        room: {
          room_id: '!foo',
          canonical_alias: '#foo:matrix.org',
          name: 'Foo',
          topic: null,
          is_space: false,
          num_joined_members: 20,
          avatar_url: null,
          join_rule: 'public',
          allowed_room_ids: [],
          guest_can_join: false,
          children: [],
        } satisfies HierarchyRoomView,
        suggested: true,
        key: 'foo',
        action: null,
        via: [],
      } satisfies HierarchyRoom,
      {
        room: {
          room_id: '!bar',
          canonical_alias: '#bar:matrix.org',
          name: 'Bar',
          topic: 'Lorem ipsum dolor sit amet',
          is_space: false,
          num_joined_members: 20,
          avatar_url: null,
          join_rule: 'public',
          allowed_room_ids: [],
          guest_can_join: false,
          children: [],
        } satisfies HierarchyRoomView,
        suggested: false,
        key: 'bar',
        action: 'join',
        via: [],
      } satisfies HierarchyRoom,
      {
        room: {
          room_id: '!baz',
          canonical_alias: '#baz:matrix.org',
          name: 'Baz',
          topic: 'Lorem ipsum dolor sit amet',
          is_space: false,
          num_joined_members: 3,
          avatar_url: null,
          join_rule: 'knock',
          allowed_room_ids: [],
          guest_can_join: false,
          children: [],
        } satisfies HierarchyRoomView,
        suggested: false,
        key: 'baz',
        action: 'knock',
        via: [],
      } satisfies HierarchyRoom,
    ],
    parent_id: '',
    owner_id: null,
    siblings: [],
    loaded: true,
    failed: false,
    pending: 0,
    space_action: null,
  } satisfies HierarchySection,
];
export const joinCandidates = () => [];
export const localHierarchyRooms = () => [];
export const mergeHierarchyRooms = () => [];
export const reorderChildren = () => [];
export const sortEdges = () => [];

export const lobbyAction = () => null;
export const activeElsewhere = () => false;
export const parsePushPayload = () => null;
export const pushAlert = () => null;
export const pushContent = () => {
  return {
    body: null,
    membership: null,
    notification_type: null,
  };
};
export const silencedByRoomMode = () => false;
export const webPushValidation = () => null;
export const roomTag = () => 'foo';
export const spaceLeaveOrder = () => undefined;
export const levelAt = () => 0;
export const permissionGroups = () => [];
export const parseSlash = () => undefined;
export const slashCommandNames = () => [];
export const pronounSets = () => undefined;
export const buildInvocation = () => undefined;
export const draftsFromText = () => undefined;
export const literalLabel = (i: string) => i;
export const matchBotCommand = () => null;
export const parseBotCommand = () => null;
export const receiverFormats = () => false;
export const markdownToDoc = () => undefined;
export const markdownToContent = () => undefined;
export const topicToHtml = () => undefined;
export const mergeSettings = (_base: unknown, local: unknown) => local;
