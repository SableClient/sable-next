<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import SpaceLobby from './SpaceLobby.svelte';
  import type { RoomListItemView } from '#src/generated/protocol';

  const { Story } = defineMeta({
    title: 'Space/Lobby',
    tags: ['autodocs'],
  });
  const space: RoomListItemView = {
    room_id: 'foo',
    name: 'Sable Space',
    topic: 'Example Topic',
    topic_html: null,
    avatar_url: null,
    display_name: 'Sable Space',
    is_direct: false,
    direct_targets: [],
    group_members: [],
    join_rule: 'unknown',
    tags: [],
    state: 'joined',
    encrypted: false,
    is_tombstoned: false,
    room_kind: 'space',
    call_participants: [],
    screen_sharers: [],
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    can_manage_children: false,
    space_children: [
      {
        room_id: '!foo',
        via: [],
        order: null,
        origin_server_ts: Date.now(),
        suggested: true,
        private: false,
      },
    ],
    bridge: null,
    media_previews: null,
    unread: 1,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    notification: { room: null, default: 'mentions' },
    counts: { unread: 0, notifying: 0, highlight: 0, marked: false },
    latest_event: null,
    canonical_alias: null,
    display_avatar_url: null,
  };
</script>

<Story name="Default">
  <SpaceLobby {space} />
</Story>
