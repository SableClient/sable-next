<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import TimelineMessage from './TimelineMessage.svelte';
  import type { TimelineItemProps } from './timeline-row.svelte';
  import type {
    ReplyView,
    TimelineItemContentView,
    TimelineItemView,
  } from '#src/generated/protocol';
  import TimelineNotice from './TimelineNotice.svelte';

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
    title: 'Message/Message',
    tags: ['autodocs'],
    parameters: {
      a11y: {
        config: {
          rules: [
            {
              // isolated component
              id: 'aria-valid-attr-value',
              enabled: false,
            },
          ],
        },
      },
    },
  });
</script>

{#snippet message(obj: object)}
  <TimelineMessage {...withItem(obj)} />
{/snippet}

<Story name="Default">
  {@render message({})}
  <TimelineMessage
    {...{
      ...args,
      overrideCosmetics: {
        colorOnLight: null,
        colorOnDark: null,
        pronouns: [
          {
            summary: 'she/her',
            language: 'en',
          },
        ],
      },
    }}
  />
  {@render message({
    content: {
      ...plainContent,
      html: 'مرحبًا أيها العالم',
    },
  })}
  {@render message({
    content: {
      ...plainContent,
      html: 'こんにちは、世界！',
    },
  })}
  {@render message({
    content: {
      ...plainContent,
      html: 'Bonjour tout le monde !',
    },
  })}
</Story>

<Story name="With Many Pronouns">
  <TimelineMessage
    {...{
      ...args,
      overrideCosmetics: {
        colorOnLight: null,
        colorOnDark: null,
        pronouns: [
          {
            summary: 'foo',
            language: 'en',
          },
          {
            summary: 'bar',
            language: 'en',
          },
          {
            summary: 'baz',
            language: 'en',
          },
          {
            summary: 'etc',
            language: 'en',
          },
          {
            summary: 'helllooooooooooo',
            language: 'en',
          },
          {
            summary: 'lorem ipsum dolor sit amet',
            language: 'en',
          },
        ],
      },
    }}
  />
</Story>

<Story name="With PMP">
  {@render message({
    per_message_profile: {
      id: id,
      display_name: 'Foo', // i needed a picture from external servers lol
      avatar_url: null,
      pronouns: [],
    },
  })}
  {@render message({
    per_message_profile: {
      id: id,
      display_name: 'Foo', // i needed a picture from external servers lol
      avatar_url: null,
      pronouns: [
        {
          summary: 'they/them',
          language: 'en',
        },
      ],
    },
  })}

  {@render message({
    per_message_profile: {
      id: id,
      display_name: 'Foo', // i needed a picture from external servers lol
      avatar_url: null,
      pronouns: [
        {
          summary: 'foo',
          language: 'en',
        },
        {
          summary: 'bar',
          language: 'en',
        },
        {
          summary: 'baz',
          language: 'en',
        },
        {
          summary: 'etc',
          language: 'en',
        },
        {
          summary: 'helllooooooooooo',
          language: 'en',
        },
        {
          summary: 'lorem ipsum dolor sit amet',
          language: 'en',
        },
      ],
    },
  })}
</Story>

<Story name="Mention">
  {@render message({
    mention: 'loud',
  })}
  {@render message({
    mention: 'silent',
  })}
</Story>

<Story name="Forwarded">
  {@render message({
    forwarded: {
      timestamp: Date.now(),
      room_id: null,
      event_id: null,
      sender: null,
      content_valid: null,
    },
  })}
  {@render message({
    forwarded: {
      timestamp: Date.now(),
      room_id: 'foo',
      event_id: 'bar',
      sender: '@bob:matrix.org',
      content_valid: null,
    },
  })}

  <div style="font-style: italic; padding-top: var(--space-100);">(Invalid forward)</div>
  {@render message({
    forwarded: {
      room_id: 'foo',
      event_id: 'bar',
      sender: '@mallory:matrix.org',
      content_valid: false,
    },
  })}
</Story>

<Story name="Read receipts">
  {@render message({
    read_by: ['foo'],
  })}
  {@render message({
    read_by: ['foo', 'bar', 'baz'],
  })}
  {@render message({
    read_by: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
  })}
</Story>

<Story name="Reply">
  {@render message({
    in_reply_to: {
      event_id: '1',
      sender: '@alice:matrix.org',
      sender_mentioned: true,
      sender_name: 'Alice',
      body: 'Hello world!',
      fallback: null,
      emotes: [],
    } satisfies ReplyView,
  })}
  {@render message({
    in_reply_to: {
      event_id: '1',
      sender: '@alice:matrix.org',
      sender_mentioned: false,
      sender_name: 'Alice',
      body: 'Hello world!',
      fallback: null,
      emotes: [],
    } satisfies ReplyView,
  })}
  {@render message({
    in_reply_to: {
      event_id: '1',
      sender: '@alice:matrix.org',
      sender_mentioned: true,
      sender_name: 'Alice',
      body: null,
      fallback: {
        kind: 'redacted',
      },
      emotes: [],
    } satisfies ReplyView,
  })}
  {@render message({
    in_reply_to: {
      event_id: '1',
      sender: '@alice:matrix.org',
      sender_mentioned: true,
      sender_name: 'Alice',
      body: null,
      fallback: {
        kind: 'reaction',
        key: ':P',
      },
      emotes: [],
    } satisfies ReplyView,
  })}
  {@render message({
    in_reply_to: {
      event_id: '1',
      sender: '@alice:matrix.org',
      sender_mentioned: true,
      sender_name: 'Alice',
      body: null,
      fallback: {
        kind: 'redaction',
      },
      emotes: [],
    } satisfies ReplyView,
  })}
  {@render message({
    in_reply_to: {
      event_id: '1',
      sender: '@alice:matrix.org',
      sender_mentioned: true,
      sender_name: 'Alice',
      body: null,
      fallback: {
        kind: 'verification_request',
      },
      emotes: [],
    } satisfies ReplyView,
  })}
  {@render message({
    in_reply_to: {
      event_id: '1',
      sender: '@alice:matrix.org',
      sender_mentioned: true,
      sender_name: 'Alice',
      body: null,
      fallback: {
        kind: 'event',
        event_type: 'm.foo',
      },
      emotes: [],
    } satisfies ReplyView,
  })}
</Story>

<Story name="Placeholder">
  <TimelineMessage
    {...{
      ...args,
      placeholder: true,
    }}
  />
</Story>

<Story
  name="Selected"
  parameters={{
    a11y: {
      config: {
        rules: [
          {
            // not much we can do about name colors here
            id: 'color-contrast',
            enabled: false,
          },
        ],
      },
    },
  }}
>
  <TimelineMessage
    {...{
      ...args,
      selected: false,
    }}
  />
  <TimelineMessage
    {...{
      ...args,
      selected: true,
    }}
  />
  <TimelineMessage
    {...{
      ...args,
      selected: false,
    }}
  />
</Story>

<Story name="Read marker">
  <TimelineMessage {...args} />
  <TimelineNotice
    {...{
      item: {
        ...item,
        content: {
          kind: 'read_marker',
        },
      },
      unreadCount: 3,
    }}
  />
  <TimelineMessage {...args} />
</Story>

<Story name="Timeline start">
  <TimelineNotice
    {...{
      item: {
        ...item,
        content: {
          kind: 'timeline_start',
        },
      },
      unreadCount: 0,
    }}
  />
  <TimelineMessage {...args} />
  <TimelineMessage {...args} />
</Story>

<Story name="Date marker">
  <TimelineMessage {...args} />
  <TimelineNotice
    {...{
      item: {
        ...item,
        content: {
          kind: 'date_divider',
          timestamp: Date.now() - 86400000,
        },
      },
      unreadCount: 0,
    }}
  />
  <TimelineMessage {...args} />
  <TimelineNotice
    {...{
      item: {
        ...item,
        content: {
          kind: 'date_divider',
          timestamp: Date.now(),
        },
      },
      unreadCount: 0,
    }}
  />
  <TimelineMessage {...args} />
</Story>

<Story name="Highlighted">
  <span>You'll need to view this one when it loads to view the animation.</span>
  <TimelineMessage
    {...{
      ...args,
      highlighted: false,
    }}
  />
  <TimelineMessage
    {...{
      ...args,
      highlighted: true,
    }}
  />
  <TimelineMessage
    {...{
      ...args,
      highlighted: false,
    }}
  />
</Story>

<Story name="Sending">
  {@render message({
    send_state: { status: 'sending', progress: null },
  })}
  {@render message({
    send_state: {
      status: 'sending',
      progress: {
        index: 2,
        current: 100,
        total: 1000,
      },
    },
  })}
  {@render message({
    send_state: { status: 'failed', error: 'Example error', recoverable: false, blocked: null },
  })}
  {@render message({
    send_state: {
      status: 'failed',
      error: 'Example error',
      recoverable: false,
      blocked: {
        kind: 'verify_this_device',
      },
    },
  })}
  {@render message({
    send_state: {
      status: 'failed',
      error: 'Example error',
      recoverable: false,
      blocked: {
        kind: 'identity_changed',
        user_ids: ['Bob', 'Mallory'],
      },
    },
  })}
</Story>
