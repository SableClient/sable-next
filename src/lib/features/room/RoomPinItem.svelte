<script lang="ts">
  import PushPinSlashIcon from 'phosphor-svelte/lib/PushPinSlashIcon';
  import type { MemberView, TimelineItemView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import MessagePreview from './messages/MessagePreview.svelte';
  import { opensFrom } from './messages/message-preview';

  interface Props {
    roomId: string;
    eventId: string;
    item: TimelineItemView | null;
    members: readonly MemberView[];
    canPin: boolean;
    fresh: boolean;
    settled: boolean;
    onJump: (eventId: string) => void;
    onUnpin: (eventId: string) => void;
    onOpenMedia: (eventId: string) => void;
  }

  let {
    roomId,
    eventId,
    item,
    members,
    canPin,
    fresh,
    settled,
    onJump,
    onUnpin,
    onOpenMedia,
  }: Props = $props();
</script>

<div class={['pin-item', { fresh }]}>
  {#if !settled}
    <p class="pin-status" role="status"><Spinner small /></p>
  {:else}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="pin-open"
      onclick={(event) => {
        if (!opensFrom(event)) return;
        onJump(eventId);
      }}
    >
      <MessagePreview
        {roomId}
        {eventId}
        {item}
        {members}
        loadPreviewProfile
        timeAction={{
          label: i18n.t('common.jumpToMessage'),
          run: () => onJump(eventId),
        }}
        onJumpToEvent={onJump}
        {onOpenMedia}
      >
        {#snippet fallback()}
          <div class="pin-unreadable">
            <button
              class="pin-unreadable-open"
              type="button"
              aria-label={i18n.t('common.jumpToMessage')}
              onclick={() => onJump(eventId)}
            >
              {i18n.t('room.pinsUnreadable')}
            </button>
            {#if canPin}
              <IconButton
                variant="ghost"
                size="small"
                label={i18n.t('timeline.unpinMessage')}
                onclick={() => onUnpin(eventId)}
              >
                <PushPinSlashIcon />
              </IconButton>
            {/if}
          </div>
        {/snippet}
        {#snippet headerAction()}
          {#if canPin}
            <IconButton
              class="pin-unpin"
              variant="ghost"
              size="small"
              label={i18n.t('timeline.unpinMessage')}
              onclick={() => onUnpin(eventId)}
            >
              <PushPinSlashIcon />
            </IconButton>
          {/if}
        {/snippet}
      </MessagePreview>
    </div>
  {/if}
</div>

<style>
  .pin-status {
    display: flex;
    justify-content: center;
    margin: 0;
    padding: var(--space-500);
  }

  .pin-item {
    background: var(--bg-container);
    border-radius: var(--radius-inner);
    color: var(--bg-on-container);
    padding: var(--space-100) var(--space-200) var(--space-100) var(--space-600);
  }

  .pin-item:is(:hover, :focus-within) {
    background: var(--bg-container-hover);
    box-shadow: inset 0 0 0 var(--border-width) var(--surface-container-line);
  }

  .pin-item.fresh {
    background: color-mix(in srgb, var(--primary-container) 30%, var(--bg-container));
  }

  .pin-item.fresh:is(:hover, :focus-within) {
    background: color-mix(in srgb, var(--primary-container) 50%, var(--bg-container));
  }

  .pin-open {
    cursor: pointer;
    min-width: 0;
  }

  .pin-item :global(.pin-unpin) {
    flex: none;
    margin-inline-start: var(--space-050);
  }

  .pin-item :global(.message.mention-silent),
  .pin-item :global(.message.mention-loud) {
    margin-inline-start: calc(-1 * (var(--space-400) + var(--border-width) * 4));
    padding-inline-start: var(--space-400);
  }

  .pin-unreadable {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    gap: var(--space-100);
    padding: var(--space-300) 0;
  }

  .pin-unreadable-open {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    flex: 1;
    font: inherit;
    padding: 0;
    text-align: start;
  }

  .pin-unreadable-open:hover {
    text-decoration: underline;
  }

  @supports not (color: color-mix(in srgb, black, white)) {
    .pin-item.fresh,
    .pin-item.fresh:is(:hover, :focus-within) {
      background: var(--surface-container);
    }
  }
</style>
