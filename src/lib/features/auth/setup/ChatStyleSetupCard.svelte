<script lang="ts">
  import type { TimelineItemView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { Bookmarks, provideBookmarks } from '#lib/features/room/bookmarks.svelte.js';
  import {
    MessageDialogs,
    provideMessageDialogs,
  } from '#lib/features/room/message-dialogs.svelte.js';
  import {
    OpenMessageMenu,
    provideMessageMenu,
  } from '#lib/features/room/message-menu-open.svelte.js';
  import { PinnedEvents, providePinnedEvents } from '#lib/features/room/pinned-events.svelte.js';
  import TimelineItem from '#lib/features/room/TimelineItem.svelte';
  import { i18n } from '#lib/i18n.js';
  import { PersonaStore, providePersonaStore } from '#lib/personas/personas.svelte.js';
  import { RoomList, provideRoomList } from '#lib/rooms/room-list.svelte.js';
  import {
    preferences,
    setPreference,
    type ReplyPreviewStyle,
    type TimelineLayout,
  } from '#lib/settings/preferences.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import AuthField from '../shared/AuthField.svelte';

  let { onComplete }: { onComplete: () => void } = $props();
  const core = useCoreClient();
  providePersonaStore(new PersonaStore(core));
  provideRoomList(new RoomList(core));
  providePinnedEvents(new PinnedEvents(core.commands));
  provideBookmarks(new Bookmarks(core.commands));
  provideMessageDialogs(new MessageDialogs());
  provideMessageMenu(new OpenMessageMenu());

  const layouts: TimelineLayout[] = ['modern', 'compact', 'bubble'];
  const replies: ReplyPreviewStyle[] = ['connected', 'compact', 'expanded'];
  const layoutLabels = {
    modern: 'settings.layoutModern',
    compact: 'settings.layoutCompact',
    bubble: 'settings.layoutBubble',
  } as const;
  const replyLabels = {
    connected: 'settings.replyPreviewStyleConnected',
    compact: 'settings.replyPreviewStyleCompact',
    expanded: 'settings.replyPreviewStyleExpanded',
  } as const;
  const message: TimelineItemView = {
    id: 'setup-preview',
    event_id: null,
    transaction_id: null,
    send_state: null,
    sender: '@alex:preview.invalid',
    sender_name: 'Alex',
    sender_avatar: null,
    timestamp: Date.now(),
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
    per_message_profile: null,
    bundled_link_previews: [],
    mention: 'none',
    forwarded: null,
  };
  const reply: TimelineItemView = {
    ...message,
    id: 'setup-reply-preview',
    sender: '@sam:preview.invalid',
    sender_name: 'Sam',
    content: {
      kind: 'message',
      body: 'Sounds good!',
      html: 'Sounds good!',
      emote: false,
      notice: false,
      edited: false,
    },
    in_reply_to: {
      event_id: '$setup-preview',
      sender: '@alex:preview.invalid',
      sender_mentioned: false,
      sender_name: 'Alex',
      body: 'See you at six?',
    },
  };
</script>

<div class="chat-style-card auth-card-surface">
  <AuthField labelId="chat-style-title" label={$i18n.t('setup.layoutTitle')}>
    <p class="hint">{$i18n.t('setup.layoutDescription')}</p>
  </AuthField>

  <TooltipProvider>
    <fieldset>
      <legend>{$i18n.t('settings.layout')}</legend>
      <div class="sample" inert aria-hidden="true">
        <TimelineItem item={message} collapsed={false} layout={preferences.layout} preview />
      </div>
      <div class="choices">
        {#each layouts as value (value)}
          <label class:selected={preferences.layout === value}>
            <input
              type="radio"
              name="setup-layout"
              checked={preferences.layout === value}
              onchange={() => setPreference('layout', value)}
            />
            {$i18n.t(layoutLabels[value])}
          </label>
        {/each}
      </div>
    </fieldset>

    <fieldset>
      <legend>{$i18n.t('settings.replyPreviewStyle')}</legend>
      <div class="sample" inert aria-hidden="true">
        <TimelineItem item={reply} collapsed={false} layout={preferences.layout} preview />
      </div>
      <div class="choices">
        {#each replies as value (value)}
          <label class:selected={preferences.replyPreviewStyle === value}>
            <input
              type="radio"
              name="setup-reply"
              checked={preferences.replyPreviewStyle === value}
              onchange={() => setPreference('replyPreviewStyle', value)}
            />
            {$i18n.t(replyLabels[value])}
          </label>
        {/each}
      </div>
    </fieldset>
  </TooltipProvider>

  <Button variant="primary" block onclick={onComplete}>{$i18n.t('auth.continue')}</Button>
</div>

<style>
  .chat-style-card {
    min-width: 0;
  }

  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  fieldset {
    border: 0;
    margin: 0;
    min-width: 0;
    padding: 0;
  }

  legend {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    margin-bottom: var(--space-100);
  }

  .sample {
    --page-gutter: 0;
    --timeline-bubble-width: 100%;
    --timeline-row-gap: var(--space-300);
    --timeline-row-padding: var(--space-100);

    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius-inner);
    margin-bottom: var(--space-100);
    min-height: 5rem;
    overflow: hidden;
    padding: var(--space-200);
  }

  .choices {
    display: grid;
    gap: var(--space-100);
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .choices label {
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius-inner);
    cursor: pointer;
    font-size: var(--font-size-small);
    padding: var(--space-100);
    position: relative;
    text-align: center;
  }

  .choices label.selected {
    border-color: var(--primary-main);
  }

  .choices label:has(input:focus-visible) {
    outline: var(--focus-ring-width) solid var(--focus-ring);
  }

  .choices input {
    inset: 0;
    opacity: 0;
    position: absolute;
    z-index: 1;
  }
</style>
