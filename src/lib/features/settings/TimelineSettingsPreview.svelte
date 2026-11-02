<script lang="ts">
  import type { MemberView } from '#src/generated/protocol';

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
  import { previewMessage } from '#lib/features/room/timeline/preview-message.js';
  import {
    PinnedEvents,
    providePinnedEvents,
  } from '#lib/features/room/timeline/pinned-events.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  const core = useCoreClient();
  providePinnedEvents(new PinnedEvents(core.rpc.timeline));
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
    real_name: member.display_name,
    avatar_url: null,
    real_avatar_url: null,
    power_level: 0,
    membership: 'join',
    member_ts: null,
    kicked: false,
    service: false,
  }));

  const incoming = previewMessage('timeline-preview-incoming', 'See you at six?', {
    event_id: '$timeline-preview-incoming',
    sender: previewAlexId,
    sender_name: 'Alex',
    timestamp: baseTs,
  });

  const ownReply = previewMessage('timeline-preview-own-reply', 'Sounds good!', {
    event_id: '$timeline-preview-own-reply',
    sender: previewUserId,
    sender_name: 'You',
    timestamp: baseTs + 45_000,
    in_reply_to: {
      event_id: '$timeline-preview-incoming',
      sender: previewAlexId,
      sender_mentioned: false,
      sender_name: 'Alex',
      body: 'See you at six?',
      fallback: null,
    },
    is_own: true,
    read_by: [previewAlexId],
  });

  const ownFollowUp = previewMessage('timeline-preview-own-followup', "I'll bring snacks.", {
    event_id: '$timeline-preview-own-followup',
    sender: previewUserId,
    sender_name: 'You',
    timestamp: baseTs + 75_000,
    is_own: true,
  });

  let layout = $derived(preferences.layout);

  let alignOwn = $derived(preferences.layout === 'bubble' && preferences.alignOwnMessages);
  let spacing = $derived(preferences.messageSpacing);
</script>

<aside class="timeline-preview" aria-label={i18n.t('settings.timelinePreview')}>
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

  .timeline-preview-sample.spacing-none {
    --timeline-row-padding: 0;
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

  @media (--app-layout) {
    .timeline-preview {
      display: flex;
      flex-direction: column;
      justify-content: center;
      margin-block-start: calc(-1 * var(--space-300));
      padding-block: var(--space-300);
    }
  }
</style>
