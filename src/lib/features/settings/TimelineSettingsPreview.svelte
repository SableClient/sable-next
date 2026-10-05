<script lang="ts">
  import type { MemberView, TimelineItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import {
    MessageDialogs,
    provideMessageDialogs,
  } from '#lib/features/room/messages/message-dialogs.svelte.js';
  import {
    OpenMessageMenu,
    provideMessageMenu,
  } from '#lib/features/room/messages/message-menu-open.svelte.js';
  import TimelineItem from '#lib/features/room/timeline/TimelineItem.svelte';
  import {
    PinnedEvents,
    providePinnedEvents,
  } from '#lib/features/room/timeline/pinned-events.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  const core = useCoreClient();
  providePinnedEvents(new PinnedEvents(core.commands));
  provideMessageDialogs(new MessageDialogs());
  provideMessageMenu(new OpenMessageMenu());

  const previewRoomId = '!timeline-preview:sable.local';
  const previewUserId = '@you:preview.invalid';
  const previewAlexId = '@alex:preview.invalid';
  const baseTs = Date.now() - 90_000;

  const previewMembers: MemberView[] = [
    { user_id: previewAlexId, display_name: 'Alex' },
    { user_id: previewUserId, display_name: 'You' },
  ].map((member) => ({
    ...member,
    avatar_url: null,
    power_level: 0,
    membership: 'join',
    member_ts: null,
    kicked: false,
    service: false,
  }));

  const incoming = {
    id: 'timeline-preview-incoming',
    event_id: '$timeline-preview-incoming',
    transaction_id: null,
    send_state: null,
    sender: previewAlexId,
    sender_name: 'Alex',
    sender_avatar: null,
    timestamp: baseTs,
    content: {
      kind: 'message',
      body: 'See you at six?',
      html: 'See you at six?',
      emote: false,
      notice: false,
      edited: false,
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
  } satisfies TimelineItemView;

  const ownReply = {
    ...incoming,
    id: 'timeline-preview-own-reply',
    event_id: '$timeline-preview-own-reply',
    sender: previewUserId,
    sender_name: 'You',
    timestamp: baseTs + 45_000,
    content: {
      ...incoming.content,
      kind: 'message',
      body: 'Sounds good!',
      html: 'Sounds good!',
    },
    in_reply_to: {
      event_id: '$timeline-preview-incoming',
      sender: previewAlexId,
      sender_mentioned: false,
      sender_name: 'Alex',
      body: 'See you at six?',
    },
    is_own: true,
    read_by: [previewAlexId],
  } satisfies TimelineItemView;

  const ownFollowUp: TimelineItemView = {
    ...ownReply,
    id: 'timeline-preview-own-followup',
    event_id: '$timeline-preview-own-followup',
    timestamp: baseTs + 75_000,
    content: {
      ...ownReply.content,
      kind: 'message',
      body: "I'll bring snacks.",
      html: "I'll bring snacks.",
    },
    in_reply_to: null,
    is_own: true,
    read_by: [],
    read_timestamps: {},
  };

  let layout = $derived(preferences.layout);

  let alignOwn = $derived(preferences.layout === 'bubble' && preferences.alignOwnMessages);
  let spacing = $derived(preferences.messageSpacing);
</script>

<aside class="timeline-preview" aria-label={$i18n.t('settings.timelinePreview')}>
  <div
    class={['timeline-preview-sample', `spacing-${spacing}`, `layout-${layout}`]}
    inert
    aria-hidden="true"
  >
    {#each [incoming, ownReply, ownFollowUp] as item (item.id)}
      <TimelineItem
        {item}
        collapsed={item === ownFollowUp}
        {layout}
        {alignOwn}
        roomId={previewRoomId}
        members={previewMembers}
        currentUserId={previewUserId}
        preview
      />
    {/each}
  </div>
</aside>

<style>
  .timeline-preview {
    box-sizing: border-box;
    max-width: 100%;
    min-width: 0;
    overflow-x: clip;
    padding-bottom: max(var(--space-200), var(--edge-inset-bottom));
  }

  .timeline-preview-sample {
    --page-gutter: 0;
    --timeline-bubble-width: 100%;
    --timeline-row-gap: var(--space-300);
    --timeline-row-padding: var(--space-100);

    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
    padding-block: var(--space-100);
    padding-inline: var(--space-200);
  }

  .timeline-preview-sample.spacing-compact {
    --timeline-row-padding: var(--space-050);
  }

  .timeline-preview-sample.spacing-roomy {
    --timeline-row-padding: var(--space-200);
  }

  .timeline-preview-sample
    :global(.message.collapsed:not(.layout-compact, .layout-bubble.own.align-own)) {
    padding-inline-start: calc(var(--avatar-size-small) + var(--timeline-row-gap));
  }

  @media (width >= 48rem) {
    .timeline-preview {
      display: flex;
      flex-direction: column;
      justify-content: center;
      margin-block-start: calc(-1 * var(--space-300));
      padding-block: var(--space-300);
    }
  }
</style>
