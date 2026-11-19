<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import TimelineMessage from './TimelineMessage.svelte';
  import type { TimelineItemProps } from './timeline-row.svelte';
  import type {
    MembershipChangeView,
    StateChangeView,
    TimelineItemContentView,
    TimelineItemView,
  } from '#src/generated/protocol';
  import MediaContent from '#lib/ui/MediaContent.svelte';
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
    title: 'Message/Message content types',
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

{#snippet notice(obj: object)}
  <TimelineNotice
    {...{
      item: {
        ...item,
        ...obj,
      },
      unreadCount: 0,
    }}
  />
{/snippet}

{#snippet message(obj: object)}
  <TimelineMessage {...withItem(obj)} />
{/snippet}

<Story name="Sticker">
  {@render message({
    content: {
      kind: 'sticker',
      body: 'Look at my sticker',
      source: 'https://placehold.co/200x200.png',
      mime: 'image/png',
      width: 200,
      height: 200,
    },
  })}
</Story>

<Story name="Image">
  {@render message({
    content: {
      kind: 'image',
      filename: 'image.png',
      source: 'https://placehold.co/800x600',
      spoiler: null,
      blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
    },
  })}
</Story>

<Story name="Gallery">
  <TimelineMessage
    {...withItem({
      content: {
        kind: 'gallery',
        body: 'look at my images',
        html: 'look at my images',
        items: [
          {
            kind: 'image',
            filename: 'image.png',
            source: 'https://placehold.co/800x600',
            spoiler: null,
            blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
          },
          {
            kind: 'image',
            filename: 'image.png',
            source: 'https://placehold.co/800x600',
            spoiler: null,
            blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
          },
          {
            kind: 'image',
            filename: 'image.png',
            source: 'https://placehold.co/800x600',
            spoiler: null,
            blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
          },
        ],
      },
    })}
  />

  <details>
    <summary>
      <span style="font-weight: bold;">Variants</span>
    </summary>

    <TimelineMessage
      {...withItem({
        content: {
          kind: 'gallery',
          body: 'look at my images',
          html: 'look at my images',
          items: [
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
          ],
        },
      })}
    />

    <TimelineMessage
      {...withItem({
        content: {
          kind: 'gallery',
          body: 'look at my images',
          html: 'look at my images',
          items: [
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
          ],
        },
      })}
    />

    <TimelineMessage
      {...withItem({
        content: {
          kind: 'gallery',
          body: 'look at my images',
          html: 'look at my images',
          items: [
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
          ],
        },
      })}
    />

    <TimelineMessage
      {...withItem({
        content: {
          kind: 'gallery',
          body: 'look at my images',
          html: 'look at my images',
          items: [
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
          ],
        },
      })}
    />

    <TimelineMessage
      {...withItem({
        content: {
          kind: 'gallery',
          body: 'look at my images',
          html: 'look at my images',
          items: [
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
          ],
        },
      })}
    />

    <TimelineMessage
      {...withItem({
        content: {
          kind: 'gallery',
          body: 'look at my images',
          html: 'look at my images',
          items: [
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
            {
              kind: 'image',
              filename: 'image.png',
              source: 'https://placehold.co/800x600',
              spoiler: null,
              blurhash: 'LxHrbxN4PRPU;rNhwIj?KrX9z;rW',
            },
          ],
        },
      })}
    />
  </details>
</Story>

<Story name="Audio">
  <div style="display: flex; flex-flow: column nowrap; gap: var(--space-100)">
    <TimelineMessage
      {...withItem({
        content: {
          kind: 'audio',
          filename: 'find it.flac',
          source: 'https://example.com/find it.flac',
          voice: false,
          metadata: {
            title: 'find it',
            artist: 'vimae',
            album: 'nightlight',
            cover_art_blurhash: 'UHES|,}b0{0x1GJ6=f-C1FJ6$*-V$kspWBR%',
          },
        },
      })}
    />

    <span style="font-weight: bold;">Variants:</span>

    <MediaContent
      source="https://copse.f0rest.net/junk/find%20it.flac"
      mime="audio/flac"
      filename="find it.flac"
      kind="audio"
      audioMetadata={{
        title: 'find it',
        artist: 'vimae',
        album: 'nightlight',
        cover_art_blurhash: 'UHES|,}b0{0x1GJ6=f-C1FJ6$*-V$kspWBR%',
      }}
    />

    <MediaContent
      source="https://copse.f0rest.net/junk/find%20it.flac"
      mime="audio/flac"
      filename="find it.flac"
      kind="audio"
      audioMetadata={{
        title: 'find it',
        artist: 'vimae',
        album: 'nightlight',
        cover_art_blurhash: null,
      }}
    />

    <MediaContent
      source="https://copse.f0rest.net/junk/outgoing_call.wav"
      mime="audio/webm"
      filename="outgoing_call.webm"
      kind="audio"
      durationMs={2000}
    />

    <MediaContent
      source="https://copse.f0rest.net/junk/outgoing_call.wav"
      mime="audio/webm"
      filename="outgoing_call.webm"
      kind="audio"
      waveform={[1, 2, 4, 2, 5, 2, 4, 6, 8, 7, 4, 2, 2, 1, 1, 2, 2, 3, 3]}
    />
  </div>
</Story>

<Story name="Video">
  <div style="display: flex; flex-flow: column nowrap; gap: var(--space-100)">
    <TimelineMessage
      {...withItem({
        content: {
          kind: 'video',
          filename: 'big buck bunny.mp4',
          source: 'https://copse.f0rest.net/junk/Big_Buck_Bunny_4K.webm',
          caption: 'look at this funny video',
          external_url: 'https://copse.f0rest.net/junk/Big_Buck_Bunny_4K.webm',
          mime: 'video/webm',
          spoiler: null,
          blurhash: 'LMFZN000?vDzR0Mu-rD%p8oI%KV}',
        },
      })}
    />

    <span style="font-weight: bold;">Variants:</span>

    <MediaContent
      source="https://copse.f0rest.net/junk/Big_Buck_Bunny_4K.webm"
      mime="video/webm"
      filename="Big_Buck_Bunny_4K.webm"
      kind="video"
    />
  </div></Story
>

<Story name="File">
  {@render message({
    content: {
      kind: 'file',
      filename: 'file.json',
      source: 'https://copse.f0rest.net/junk/example.json',
    },
  })}
</Story>

<Story name="Location">
  {@render message({
    content: {
      kind: 'location',
      body: "i'm here",
      geo_uri: 'geo:48.8584,2.2945',
      latitude: null,
      longitude: null,
    },
  })}
</Story>

<Story name="Live Location">
  {@render message({
    content: {
      kind: 'live_location',
      body: "i'm here",
      latitude: 48.8584,
      longitude: 2.2945,
      live: true,
      expires_at: Date.now() + 12000,
      updated_at: Date.now() - 1000,
    },
  })}
</Story>

<Story name="Call Invite">
  {@render notice({
    content: {
      kind: 'call_invite',
    },
  })}
</Story>

<Story name="Verification Request">
  {@render notice({
    content: {
      kind: 'verification_request',
    },
  })}
</Story>

<Story name="Cute">
  {@render notice({
    content: {
      kind: 'cute',
      cute_type: 'hug',
      body: '🤗',
    },
  })}
  {@render notice({
    content: {
      kind: 'cute',
      cute_type: 'googly_eyes',
      body: '👀',
    },
  })}
  {@render notice({
    content: {
      kind: 'cute',
      cute_type: 'unknown',
      body: '✨',
    },
  })}
</Story>

<Story name="Malformed">
  {@render notice({
    content: {
      kind: 'malformed',
      event_type: 'foo',
    },
  })}
</Story>

<Story name="Poll">
  {@render message({
    content: {
      kind: 'poll',
      poll: {
        question: "What's for dinner",
        answers: [
          {
            voters: ['foo', 'bar', 'baz'],
            id: 'foo',
            text: 'Circles',
            votes: 300,
            selected: true,
          },
          {
            voters: ['bar', 'baz'],
            id: 'bar',
            text: 'Squares',
            votes: 280,
            selected: false,
          },
          {
            voters: ['baz'],
            id: 'baz',
            text: 'Triangles',
            votes: 30,
            selected: false,
          },
        ],
        max_selections: 2,
        undisclosed: false,
        ended_at: null,
        edited: false,
      },
    },
  })}
</Story>

<Story name="Redacted">
  {@render message({
    content: {
      kind: 'redacted',
      reason: null,
      redacted_by: null,
    },
  })}
  {@render message({
    content: {
      kind: 'redacted',
      reason: 'spam',
      redacted_by: null,
    },
  })}
  {@render message({
    content: {
      kind: 'redacted',
      reason: 'spam',
      redacted_by: '@alice:matrix.org',
    },
  })}
</Story>

{#snippet utd(reason: string)}
  {@render message({
    content: {
      kind: 'unable_to_decrypt',
      reason,
      session_id: null,
    },
  })}
{/snippet}
<Story name="Unable to Decrypt">
  {@render utd('unknown')}
  {@render utd('sent_before_we_joined')}
  {@render utd('verification_violation')}
  {@render utd('unsigned_device')}
  {@render utd('unknown_device')}
  {@render utd('historical_message_backup_disabled')}
  {@render utd('historical_message_device_unverified')}
  {@render utd('withheld_for_unverified_or_insecure_device')}
  {@render utd('withheld_by_sender')}
</Story>

{#snippet membership(change: MembershipChangeView)}
  {@render notice({
    content: {
      kind: 'membership',
      user_id: '@alice:matrix.org',
      change,
      display_name: 'Alice',
      reason: null,
    },
  })}
{/snippet}
<Story name="Membership">
  {@render membership('joined')}
  {@render membership('left')}
  {@render membership('banned')}
  {@render membership('unbanned')}
  {@render membership('kicked')}
  {@render membership('invited')}
  {@render membership('kicked_and_banned')}
  {@render membership('invitation_accepted')}
  {@render membership('invitation_rejected')}
  {@render membership('invitation_revoked')}
  {@render membership('knocked')}
  {@render membership('knock_accepted')}
  {@render membership('knock_retracted')}
  {@render membership('knock_denied')}
  {@render membership('other')}
</Story>

<Story name="Profile change">
  {@render notice({
    content: {
      kind: 'profile_change',
      user_id: '@alice:matrix.org',
      display_name: {
        old: 'Foo',
        new: 'Bar',
      },
      avatar: null,
    },
  })}
  {@render notice({
    content: {
      kind: 'profile_change',
      user_id: '@alice:matrix.org',
      display_name: {
        old: 'Foo',
        new: null,
      },
      avatar: null,
    },
  })}
  {@render notice({
    content: {
      kind: 'profile_change',
      user_id: '@alice:matrix.org',
      display_name: {
        old: null,
        new: 'Bar',
      },
      avatar: null,
    },
  })}
  {@render notice({
    content: {
      kind: 'profile_change',
      user_id: '@alice:matrix.org',
      display_name: null,
      avatar: { old: 'https://placehold.co/200x200', new: 'https://placehold.co/300x300' },
    },
  })}
</Story>

{#snippet se(change: StateChangeView | null)}
  {@render notice({
    content: {
      kind: 'state_event',
      event_type: 'm.foo',
      state_key: '',
      content: { foo: 'bar', new: 'hi', complex_object: { one: 1, two: 2, three: 3 } },
      prev_content: { foo: 'baz', old: 'bye' },
      change,
    },
  })}
{/snippet}
<Story name="State Event">
  {@render se(null)}
  {@render se({
    kind: 'room_name',
    name: 'Foo',
    previous: 'Bar',
  })}
  {@render se({
    kind: 'room_topic',
    topic: 'new topic',
  })}
  {@render se({
    kind: 'room_topic',
    topic: null,
  })}
  {@render se({
    kind: 'room_avatar',
    removed: true,
  })}
  {@render se({
    kind: 'room_avatar',
    removed: false,
  })}
  {@render se({
    kind: 'pinned_events',
    added: ['id'],
    removed: [],
    total: 1,
  })}
  {@render se({
    kind: 'pinned_events',
    added: [],
    removed: ['id'],
    total: 1,
  })}
  {@render se({
    kind: 'pinned_events',
    added: [],
    removed: [],
    total: 1,
  })}
  {@render se({
    kind: 'call_membership',
    joined: true,
  })}
  {@render se({
    kind: 'call_membership',
    joined: false,
  })}
  {@render se({
    kind: 'room_rules',
    removed: true,
  })}
  {@render se({
    kind: 'room_rules',
    removed: false,
  })}
</Story>
