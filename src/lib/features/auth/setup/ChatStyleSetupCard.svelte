<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { Bookmarks, provideBookmarks } from '#lib/rooms/bookmarks.svelte.js';
  import {
    MessageDialogs,
    provideMessageDialogs,
  } from '#lib/features/room/messages/message-dialogs.svelte.js';
  import {
    OpenMessageMenu,
    provideMessageMenu,
  } from '#lib/features/room/messages/message-menu-open.svelte.js';
  import {
    PinnedEvents,
    providePinnedEvents,
  } from '#lib/features/room/timeline/pinned-events.svelte.js';
  import TimelineItem from '#lib/features/room/timeline/TimelineItem.svelte';
  import { previewMessage } from '#lib/features/room/timeline/preview-message.js';
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
  provideRoomList(new RoomList());
  providePinnedEvents(new PinnedEvents(core.rpc.timeline));
  provideBookmarks(new Bookmarks(core.rpc.account));
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
  const message = previewMessage('setup-preview', 'See you at six?', {
    sender: '@alex:preview.invalid',
    sender_name: 'Alex',
    timestamp: Date.now(),
  });
  const reply = previewMessage('setup-reply-preview', 'Sounds good!', {
    sender: '@sam:preview.invalid',
    sender_name: 'Sam',
    timestamp: message.timestamp,
    in_reply_to: {
      event_id: '$setup-preview',
      sender: '@alex:preview.invalid',
      sender_mentioned: false,
      sender_name: 'Alex',
      body: 'See you at six?',
      fallback: null,
    },
  });
</script>

<div class="chat-style-card auth-card-surface">
  <AuthField labelId="chat-style-title" label={i18n.t('setup.layoutTitle')}>
    <p class="hint">{i18n.t('setup.layoutDescription')}</p>
  </AuthField>

  <TooltipProvider>
    <fieldset>
      <legend>{i18n.t('settings.layout')}</legend>
      <div class="sample" inert aria-hidden="true">
        <TimelineItem item={message} collapsed={false} layout={preferences.layout} preview />
      </div>
      <div class="choices">
        {#each layouts as value (value)}
          <label class={{ selected: preferences.layout === value }}>
            <input
              type="radio"
              name="setup-layout"
              checked={preferences.layout === value}
              onchange={() => setPreference('layout', value)}
            />
            {i18n.t(layoutLabels[value])}
          </label>
        {/each}
      </div>
    </fieldset>

    <fieldset>
      <legend>{i18n.t('settings.replyPreviewStyle')}</legend>
      <div class="sample" inert aria-hidden="true">
        <TimelineItem item={reply} collapsed={false} layout={preferences.layout} preview />
      </div>
      <div class="choices">
        {#each replies as value (value)}
          <label class={{ selected: preferences.replyPreviewStyle === value }}>
            <input
              type="radio"
              name="setup-reply"
              checked={preferences.replyPreviewStyle === value}
              onchange={() => setPreference('replyPreviewStyle', value)}
            />
            {i18n.t(replyLabels[value])}
          </label>
        {/each}
      </div>
    </fieldset>
  </TooltipProvider>

  <Button variant="primary" block onclick={onComplete}>{i18n.t('auth.continue')}</Button>
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
