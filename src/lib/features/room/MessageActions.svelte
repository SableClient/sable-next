<script lang="ts">
  import './message-menu.css';
  import { DropdownMenu } from 'bits-ui';
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';
  import EditIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import MoreIcon from 'phosphor-svelte/lib/DotsThreeIcon';

  import { i18n } from '$lib/i18n';

  interface Props {
    onReply?: () => void;
    onEdit?: () => void;
    onDelete?: () => void;
    onCopyText?: () => void;
    onCopyLink?: () => void;
  }

  let { onReply, onEdit, onDelete, onCopyText, onCopyLink }: Props = $props();
  let hasOverflow = $derived(
    onReply !== undefined ||
      onCopyText !== undefined ||
      onCopyLink !== undefined ||
      onDelete !== undefined
  );
</script>

<div class="message-actions">
  {#if onReply}
    <button type="button" aria-label={$i18n.t('timeline.reply')} onclick={onReply}>
      <ReplyIcon />
    </button>
  {/if}
  {#if onEdit}
    <button type="button" aria-label={$i18n.t('timeline.editMessage')} onclick={onEdit}>
      <EditIcon />
    </button>
  {/if}
  {#if hasOverflow}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={$i18n.t('timeline.moreActions')}>
        <MoreIcon />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          class="message-menu"
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
        >
          {#if onReply}
            <DropdownMenu.Item onclick={onReply}
              >{$i18n.t('timeline.replyInThread')}</DropdownMenu.Item
            >
          {/if}
          {#if onCopyText}
            <DropdownMenu.Item onclick={onCopyText}
              >{$i18n.t('timeline.copyMessage')}</DropdownMenu.Item
            >
          {/if}
          {#if onCopyLink}
            <DropdownMenu.Item onclick={onCopyLink}
              >{$i18n.t('timeline.copyLink')}</DropdownMenu.Item
            >
          {/if}
          {#if onDelete}
            <DropdownMenu.Separator class="message-menu-separator" />
            <DropdownMenu.Item class="message-menu-danger" onclick={onDelete}>
              {$i18n.t('timeline.deleteMessage')}
            </DropdownMenu.Item>
          {/if}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  {/if}
</div>

<style>
  .message-actions {
    background: var(--sable-surface-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    inset-inline-end: var(--space-2);

    /* Rides the row's top edge so it never covers the message text. */
    bottom: calc(100% - var(--space-1));
    box-shadow: var(--shadow-float);
    display: flex;
    gap: 2px;
    opacity: 0;
    padding: 2px;
    pointer-events: none;
    position: absolute;
    z-index: 3;
  }

  .message-actions :global(button) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: flex;
    height: 1.5rem;
    justify-content: center;
    padding: 0;
    position: relative;
    width: var(--control-height-small);
  }

  /* Keeps the control 24px tall while the target reaches 36px. */
  .message-actions :global(button::after) {
    content: '';
    inset: -0.375rem -1px;
    position: absolute;
  }

  .message-actions :global(button > svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .message-actions :global(button:focus-visible) {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: -1px;
  }

  .message-actions :global(button[aria-expanded='true']) {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  @media (prefers-reduced-motion: no-preference) {
    .message-actions {
      transition: opacity var(--motion-normal) var(--motion-easing-standard);
    }
  }

  @media (hover: hover) and (pointer: fine) {
    .message-actions :global(button:hover) {
      background: var(--sable-surface-var-container);
      color: var(--sable-bg-on-container);
    }
  }
</style>
