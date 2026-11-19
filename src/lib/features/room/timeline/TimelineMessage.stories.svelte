<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { expect } from 'storybook/test';

  import TimelineMessage from './TimelineMessage.svelte';
  import type { TimelineItemProps } from './timeline-row.svelte';
  import type {
    PerMessageProfileView,
    TimelineItemContentView,
    TimelineItemView,
  } from '#src/generated/protocol';

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
    sender: 'alice',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: Date.now() - 60,
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

  const withItem = (obj: object) => {
    return {
      ...args,
      item: {
        ...item,
        ...obj,
      },
    };
  };

  const { Story } = defineMeta({
    title: 'Room/Timeline Message',
    tags: ['autodocs'],
  });
</script>

<Story name="Default">
  <TimelineMessage {...args} />
</Story>

<Story name="With PMP">
  <TimelineMessage
    {...withItem({
      per_message_profile: {
        id: id,
        display_name: 'Tasque Manager', // i needed a picture from external servers lol
        avatar_url: 'https://f0rest.net/art/abstract/task.png',
        pronouns: [],
      },
    })}
  />
</Story>

<Story name="Encryption/Authenticity not guaranteed">
  <TimelineMessage
    {...withItem({
      shield: {
        code: 'authenticity_not_guaranteed',
        critical: false,
      },
    })}
  />
</Story>

<Story name="Encryption/Cleartext">
  <TimelineMessage
    {...withItem({
      shield: {
        code: 'sent_in_clear',
        critical: true,
      },
    })}
  />
</Story>

<Story name="Encryption/Shared keys">
  <TimelineMessage
    {...withItem({
      shared_by: id,
    })}
  />
</Story>
