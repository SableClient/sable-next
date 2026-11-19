<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import TimelineMessage from './TimelineMessage.svelte';
  import type { TimelineItemProps } from './timeline-row.svelte';
  import type { TimelineItemContentView, TimelineItemView } from '#src/generated/protocol';

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

  const withContent = (obj: object) => {
    return {
      ...args,
      item: {
        ...item,
        content: {
          ...plainContent,
          ...obj,
        },
      },
    };
  };

  const { Story } = defineMeta({
    title: 'Message/Message with Rich Text',
    tags: ['autodocs'],
    parameters: {
      a11y: {
        config: {
          rules: [
            {
              // custom colors
              id: 'color-contrast',
              enabled: false,
            },
          ],
        },
      },
    },
  });
</script>

{#snippet message(obj: object)}
  <TimelineMessage {...withContent(obj)} />
{/snippet}

<Story name="Italic">
  {@render message({
    html: 'Hello <em>world!</em>',
  })}
</Story>

<Story name="Bold">
  {@render message({
    html: 'Hello <strong>world!</strong>',
  })}
</Story>

<Story name="Strikethrough">
  {@render message({
    html: 'Hello <del>world!</del>',
  })}
</Story>

<Story name="Inline code">
  {@render message({
    html: '<code>Hello world!</code>',
  })}
</Story>

<Story name="Blockquote">
  {@render message({
    html: '<blockquote><p>Hello world!</p></blockquote>',
  })}
</Story>

<Story name="Unordered list">
  {@render message({
    html: '<ul><li>one</li><li>two</li><li>three</li></ul>',
  })}
</Story>

<Story name="Ordered list">
  {@render message({
    html: '<ol><li>one</li><li>two</li><li>three</li></ol>',
  })}
</Story>

<Story name="Spoiler">
  {@render message({
    html: '<span data-mx-spoiler="">spoiler</span>',
  })}
</Story>

<Story name="Heading">
  {@render message({
    html: '<h1>heading</h1><h2>heading</h2><h3>heading</h3>',
  })}
</Story>

<Story name="Separator">
  {@render message({
    html: '<p>foo</p><hr><p>bar</p>',
  })}
</Story>

<Story name="Code block">
  {@render message({
    html: '<pre><code class="language-json">{ foo: "bar" } </code></pre>',
  })}
</Story>

<Story name="Table">
  {@render message({
    html: '<table><tbody><tr><th>a</th><th>a</th></tr><tr><td>b</td><td>b</td></tr></tbody></table>',
  })}
</Story>

<Story name="Colors">
  {@render message({
    html: '<span data-mx-color=\"#e5484d\">color</span></p><p><span data-mx-bg-color=\"#e5484d\">color</span></p><p><span data-mx-color=\"#ffffff\"><span data-mx-bg-color=\"#000000\">color</span></span>',
  })}
</Story>

<Story name="Timestamp">
  {@render message({
    html: '<time datetime=\"1970-01-01T00:00:00Z\">Jan 1, 1970, 00:00 (UTC)</time>',
  })}
</Story>

<Story name="User mention">
  {@render message({
    html: '<a href=\"matrix:u/alice:matrix.org\">@Alice</a>',
  })}
</Story>

<Story name="Room mention">
  {@render message({
    html: '<a href=\"matrix:roomid/foo\">#foo</a>',
  })}
</Story>

<Story name="Event mention">
  {@render message({
    html: '<a href=\"matrix:event/foo\">Foo bar baz...</a>',
  })}
</Story>
<Story name="Inline image">
  {@render message({
    html: '<img data-mx-emoticon=\"\" src=\"mxc://deep.f0rest.net/wSuNNgFMV0gxsMfRBMhQlxtlLnLJ4fFP\" alt=\"neodeer\" title=\"neodeer\" height=\"32\">',
  })}
</Story>
