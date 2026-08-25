import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';

export type PermissionLocation =
  | { kind: 'event'; eventType: string }
  | { kind: 'state'; eventType: string }
  | { kind: 'events-default' }
  | { kind: 'state-default' }
  | { kind: 'action'; action: 'invite' | 'kick' | 'ban' | 'redact' }
  | { kind: 'notification-room' };

export interface PermissionItem {
  label: string;
  location: PermissionLocation;
}

export interface PermissionGroup {
  label: string;
  items: readonly PermissionItem[];
}

const MESSAGES: PermissionGroup = {
  label: 'room.permGroupMessages',
  items: [
    { label: 'room.permSendMessages', location: { kind: 'event', eventType: 'm.room.message' } },
    { label: 'room.permSendStickers', location: { kind: 'event', eventType: 'm.sticker' } },
    { label: 'room.permSendReactions', location: { kind: 'event', eventType: 'm.reaction' } },
    { label: 'room.permPingRoom', location: { kind: 'notification-room' } },
    {
      label: 'room.permPinMessages',
      location: { kind: 'state', eventType: 'm.room.pinned_events' },
    },
    { label: 'room.permOtherMessages', location: { kind: 'events-default' } },
  ],
};

const CALLS: PermissionGroup = {
  label: 'room.permGroupCalls',
  items: [
    {
      label: 'room.permStartCalls',
      location: { kind: 'state', eventType: 'org.matrix.msc3401.call' },
    },
    {
      label: 'room.permJoinCalls',
      location: { kind: 'state', eventType: 'org.matrix.msc3401.call.member' },
    },
  ],
};

const MODERATION: PermissionGroup = {
  label: 'room.permGroupModeration',
  items: [
    { label: 'room.permInvite', location: { kind: 'action', action: 'invite' } },
    { label: 'room.permKick', location: { kind: 'action', action: 'kick' } },
    { label: 'room.permBan', location: { kind: 'action', action: 'ban' } },
    { label: 'room.permRedactOthers', location: { kind: 'action', action: 'redact' } },
    {
      label: 'room.permRedactSelf',
      location: { kind: 'event', eventType: 'm.room.redaction' },
    },
  ],
};

function overview(isSpace: boolean): PermissionGroup {
  return {
    label: isSpace ? 'room.permGroupSpaceOverview' : 'room.permGroupRoomOverview',
    items: [
      { label: 'room.permAvatar', location: { kind: 'state', eventType: 'm.room.avatar' } },
      { label: 'room.permName', location: { kind: 'state', eventType: 'm.room.name' } },
      { label: 'room.permTopic', location: { kind: 'state', eventType: 'm.room.topic' } },
    ],
  };
}

function settings(isSpace: boolean): PermissionGroup {
  return {
    label: 'room.permGroupSettings',
    items: [
      { label: 'room.permAccess', location: { kind: 'state', eventType: 'm.room.join_rules' } },
      {
        label: 'room.permPublishAddress',
        location: { kind: 'state', eventType: 'm.room.canonical_alias' },
      },
      {
        label: 'room.permChangePermissions',
        location: { kind: 'state', eventType: 'm.room.power_levels' },
      },
      ...(isSpace
        ? []
        : [
            {
              label: 'room.permEncryption',
              location: { kind: 'state' as const, eventType: 'm.room.encryption' },
            },
            {
              label: 'room.permHistoryVisibility',
              location: { kind: 'state' as const, eventType: 'm.room.history_visibility' },
            },
          ]),
      { label: 'room.permUpgrade', location: { kind: 'state', eventType: 'm.room.tombstone' } },
      { label: 'room.permOtherSettings', location: { kind: 'state-default' } },
    ],
  };
}

const OTHER: PermissionGroup = {
  label: 'room.permGroupOther',
  items: [
    {
      label: 'room.permImagePacks',
      location: { kind: 'state', eventType: 'im.ponies.room_emotes' },
    },
    { label: 'room.permServerAcl', location: { kind: 'state', eventType: 'm.room.server_acl' } },
  ],
};

const SPACE_MANAGE: PermissionGroup = {
  label: 'room.permGroupManage',
  items: [
    { label: 'room.permManageRooms', location: { kind: 'state', eventType: 'm.space.child' } },
    { label: 'room.permOtherMessages', location: { kind: 'events-default' } },
  ],
};

export function permissionGroups(isSpace: boolean): readonly PermissionGroup[] {
  if (isSpace) {
    return [SPACE_MANAGE, MODERATION, overview(true), settings(true), OTHER];
  }
  return [MESSAGES, CALLS, MODERATION, overview(false), settings(false), OTHER];
}

export function levelAt(levels: RoomPowerLevelsView, location: PermissionLocation): number {
  switch (location.kind) {
    case 'event':
      return levels.events[location.eventType] ?? levels.events_default;
    case 'state':
      return levels.events[location.eventType] ?? levels.state_default;
    case 'events-default':
      return levels.events_default;
    case 'state-default':
      return levels.state_default;
    case 'action':
      return levels[location.action];
    case 'notification-room':
      return levels.notifications_room;
  }
}

export function withLevel(
  levels: RoomPowerLevelsView,
  location: PermissionLocation,
  level: number
): RoomPowerLevelsView {
  switch (location.kind) {
    case 'event':
    case 'state':
      return { ...levels, events: { ...levels.events, [location.eventType]: level } };
    case 'events-default':
      return { ...levels, events_default: level };
    case 'state-default':
      return { ...levels, state_default: level };
    case 'action':
      return { ...levels, [location.action]: level };
    case 'notification-room':
      return { ...levels, notifications_room: level };
  }
}

export function toEventContent(levels: RoomPowerLevelsView): Record<string, unknown> {
  return {
    ban: levels.ban,
    kick: levels.kick,
    redact: levels.redact,
    invite: levels.invite,
    events_default: levels.events_default,
    state_default: levels.state_default,
    users_default: levels.users_default,
    events: levels.events,
    users: levels.users,
    notifications: { room: levels.notifications_room },
  };
}

export function canSendState(
  levels: RoomPowerLevelsView | null,
  ownPowerLevel: number,
  eventType: string
): boolean {
  if (levels === null) return false;
  return ownPowerLevel >= (levels.events[eventType] ?? levels.state_default);
}
