import type { MemberView, RoomListItemView } from '#src/generated/protocol';
import { withCounts } from '#lib/rooms/summary-fixtures.js';

export function roomView(overrides: Partial<RoomListItemView> = {}): RoomListItemView {
  return withCounts({
    room_id: '!room:example.org',
    canonical_alias: null,
    name: null,
    topic: null,
    topic_html: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_tombstoned: false,
    room_kind: 'text',
    call_participants: [],
    screen_sharers: [],
    supports_knock: false,
    supports_restricted: false,
    supports_knock_restricted: false,
    space_children: [],
    bridge: null,
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    ...overrides,
  });
}

export function memberView(overrides: Partial<MemberView> = {}): MemberView {
  return {
    user_id: '@user:example.org',
    display_name: null,
    avatar_url: null,
    real_name: null,
    real_avatar_url: null,
    power_level: 0,
    membership: 'join',
    member_ts: null,
    kicked: false,
    service: false,
    ...overrides,
  };
}
