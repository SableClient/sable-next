<script lang="ts">
  import BellIcon from 'phosphor-svelte/lib/BellIcon';
  import BellSlashIcon from 'phosphor-svelte/lib/BellSlashIcon';
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpRightIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { cubicOut } from 'svelte/easing';
  import { slide } from 'svelte/transition';

  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import { MOTION_MS, motionMs } from '#lib/ui/motion.js';

  import type { ComposerContext } from '#lib/composer/composer-context.js';

  interface Props {
    context: ComposerContext;
    onCancel?: () => void;
    onToggleSilentReply?: () => void;
    onJump?: (eventId: string) => void;
  }

  let { context, onCancel, onToggleSilentReply, onJump }: Props = $props();
  let silent = $derived(context.silentReply === true);
</script>

<div class="context" transition:slide={{ duration: motionMs(MOTION_MS.quick), easing: cubicOut }}>
  {#if context.kind === 'edit'}
    <span class="context-kind">{i18n.t('composer.editing')}</span>
  {:else if context.kind === 'schedule'}
    <span class="context-kind">{i18n.t('composer.editingScheduled')}</span>
  {:else}
    <span class="context-kind context-reply">
      <span class="context-reply-icon" aria-hidden="true"><ReplyIcon /></span>
      <span class="context-sender" aria-hidden="true">{context.sender}</span>
      <span class="screen-reader-only"
        >{i18n.t('composer.replyingTo', { name: context.sender ?? '' })}</span
      >
    </span>
  {/if}
  {#if onJump && context.kind !== 'schedule'}
    <button
      type="button"
      class="context-body context-jump"
      title={i18n.t('common.jumpToMessage')}
      onclick={() => onJump(context.eventId)}
    >
      {context.body}
    </button>
  {:else}
    <div class="context-body">
      {context.body}
    </div>
  {/if}
  {#if context.kind === 'reply'}
    <IconButton
      size="small"
      variant="ghost"
      label={silent ? i18n.t('composer.unmuteReply') : i18n.t('composer.muteReply')}
      aria-pressed={silent}
      onclick={onToggleSilentReply}
    >
      {#if silent}
        <BellSlashIcon />
      {:else}
        <BellIcon />
      {/if}
    </IconButton>
  {/if}
  <IconButton size="small" variant="ghost" label={i18n.t('common.cancel')} onclick={onCancel}>
    <XIcon />
  </IconButton>
</div>

<style>
  .context {
    align-items: center;
    border-bottom: var(--border-width) solid var(--surface-container-line);
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    margin-inline: calc(
        var(--space-100) + (var(--control-height-small) - var(--icon-size-small)) / 2
      )
      var(--space-150);
    min-width: 0;
    padding: var(--space-150) 0 var(--space-150);
  }

  .context-kind {
    color: var(--primary-main);
    flex: 0 1 auto;
    font-weight: var(--font-weight-medium);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-reply {
    align-items: center;
    display: flex;
    gap: var(--space-100);
  }

  .context-reply-icon {
    flex: 0 0 auto;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .context-reply-icon :global(svg) {
    display: block;
    height: 100%;
    width: 100%;
  }

  .context-sender {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-body {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-jump {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 0;
    text-align: left;
  }

  .context-jump:hover,
  .context-jump:focus-visible {
    color: var(--surface-on-container);
  }
</style>
