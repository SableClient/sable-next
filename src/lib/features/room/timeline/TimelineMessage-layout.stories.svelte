<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import TimelineMessage from './TimelineMessage.svelte';
  import type { TimelineItemProps } from './timeline-row.svelte';
  import type { TimelineItemContentView, TimelineItemView } from '#src/generated/protocol';
  import type { TimelineLayout } from '#lib/settings/definitions.ts';

  const noop = () => {};
  const id = 'foobar';

  const plainContent: TimelineItemContentView = {
    kind: 'message',
    body: 'Hello world!',
    html: '<strong>Hello</strong> world!',
    msgtype: 'text',
    edited: false,
    jumbo: null,
  };
  const item: TimelineItemView = {
    id,
    row: 'message',
    forwardable: true,
    redactable: true,
    visibility: 'always',
    event_id: id,
    transaction_id: id,
    send_state: { status: 'sent' },
    sender: '@alice:matrix.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: Date.now(),
    content: plainContent,
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
    shield: null,
    shared_by: null,
    redacted_on_ban: null,
  };

  const args: TimelineItemProps = {
    item,
    collapsed: false,
    replyPersona: null,
    threadPersona: null,
    roomId: '',
    highlighted: false,
    onMatrixLink: noop,
    onSenderProfile: noop,
    onMentionUser: noop,
    onRetrySend: noop,
    onCancelSend: noop,
    currentUserId: null,
    onToggleReaction: noop,
    onReply: noop,
    onCancelContext: noop,
    onOpenThread: noop,
    onEdit: noop,
    onDelete: noop,
    onCopyLink: noop,
    onMarkUnread: noop,
    canRedactOwn: false,
    canRedactOthers: false,
    canPin: true,
    encrypted: null,
    selected: false,
    editing: false,
    editor: undefined,
    layout: 'modern',
    preview: false,
    loadPreviewProfile: false,
    timeAction: undefined,
    headerAction: undefined,
    alignOwn: true,
    avatarsInHeaders: true,
    members: [],
    onJumpToEvent: noop,
    onOpenMedia: noop,
    onVotePoll: noop,
    onEndPoll: noop,
    events: undefined,
    onMenuOpenChange: noop,
    placeholder: false,
    placeholderCharacters: 35,
    overrideCosmetics: null,
    onSwipeMembers: noop,
  };

  const { Story } = defineMeta({
    title: 'Message/Message layouts',
    tags: ['autodocs'],
  });
</script>

{#snippet messages(layout: TimelineLayout)}
  <TimelineMessage
    {...{
      ...args,
      item: {
        ...item,
        is_own: false,
      },
      collapsed: false,
      layout,
    }}
  />
  <TimelineMessage
    {...{
      ...args,
      item: {
        ...item,
        is_own: false,
      },
      collapsed: true,
      layout,
    }}
  />
  <TimelineMessage
    {...{
      ...args,
      item: {
        ...item,
        sender: '@bob:matrix.org',
        sender_name: 'Bob',
        read_by: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
        is_own: true,
      },
      collapsed: false,
      layout,
    }}
  />
{/snippet}
<Story name="Default layout">
  {@render messages('modern')}
</Story>

<Story name="Compact">
  {@render messages('compact')}
</Story>

<Story name="Bubble">
  {@render messages('bubble')}
</Story>
