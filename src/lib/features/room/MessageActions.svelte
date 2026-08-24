<script lang="ts">
  import '#lib/ui/primitives/menu.css';
  import { DropdownMenu } from 'bits-ui';
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';
  import EditIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import MoreIcon from 'phosphor-svelte/lib/DotsThreeIcon';
  import EmojiIcon from 'phosphor-svelte/lib/SmileyIcon';

  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import ReactionPicker from './ReactionPicker.svelte';

  interface Props {
    roomId?: string;
    onReact?: (emoji: string) => void;
    onViewReactions?: () => void;
    onReadReceipts?: () => void;
    onPickerOpenChange?: (open: boolean) => void;
    onReply?: () => void;
    onEdit?: () => void;
    onDelete?: () => void;
    onCopyText?: () => void;
    onCopyLink?: () => void;
  }

  let {
    roomId = '',
    onReact,
    onViewReactions,
    onReadReceipts,
    onPickerOpenChange,
    onReply,
    onEdit,
    onDelete,
    onCopyText,
    onCopyLink,
  }: Props = $props();
  let hasOverflow = $derived(
    onReply !== undefined ||
      onCopyText !== undefined ||
      onCopyLink !== undefined ||
      onViewReactions !== undefined ||
      onReadReceipts !== undefined ||
      onDelete !== undefined
  );
</script>

<div class="message-actions">
  {#if onReact}
    <ReactionPicker
      label={$i18n.t('timeline.addReaction')}
      {roomId}
      onPick={onReact}
      onOpenChange={onPickerOpenChange}
      triggerClass="sable-button sable-button-ghost sable-button-icon sable-icon-button sable-icon-button-small message-action-button"
    >
      <EmojiIcon />
    </ReactionPicker>
  {/if}
  {#if onReply}
    <IconButton
      class="message-action-button"
      size="small"
      variant="ghost"
      label={$i18n.t('timeline.reply')}
      onclick={onReply}
    >
      <ReplyIcon />
    </IconButton>
  {/if}
  {#if onEdit}
    <IconButton
      class="message-action-button"
      size="small"
      variant="ghost"
      label={$i18n.t('timeline.editMessage')}
      onclick={onEdit}
    >
      <EditIcon />
    </IconButton>
  {/if}
  {#if hasOverflow}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <IconButton
            {...props}
            size="small"
            variant="ghost"
            class="message-action-button"
            label={$i18n.t('timeline.moreActions')}
          >
            <MoreIcon />
          </IconButton>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          class="sable-menu"
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
        >
          {#if onReply}
            <DropdownMenu.Item class="sable-menu-item" onclick={onReply}
              >{$i18n.t('timeline.replyInThread')}</DropdownMenu.Item
            >
          {/if}
          {#if onCopyText}
            <DropdownMenu.Item class="sable-menu-item" onclick={onCopyText}
              >{$i18n.t('timeline.copyMessage')}</DropdownMenu.Item
            >
          {/if}
          {#if onCopyLink}
            <DropdownMenu.Item class="sable-menu-item" onclick={onCopyLink}
              >{$i18n.t('timeline.copyLink')}</DropdownMenu.Item
            >
          {/if}
          {#if onViewReactions}
            <DropdownMenu.Item class="sable-menu-item" onclick={onViewReactions}
              >{$i18n.t('timeline.viewReactions')}</DropdownMenu.Item
            >
          {/if}
          {#if onReadReceipts}
            <DropdownMenu.Item class="sable-menu-item" onclick={onReadReceipts}
              >{$i18n.t('timeline.readReceipts')}</DropdownMenu.Item
            >
          {/if}
          {#if onDelete}
            <DropdownMenu.Separator class="sable-menu-separator" />
            <DropdownMenu.Item
              class="sable-menu-item sable-menu-item-destructive"
              onclick={onDelete}
            >
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
    align-items: center;
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    inset-inline-end: var(--space-2);
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

  .message-actions :global(.message-action-button) {
    --button-height: 1.5rem;

    color: var(--sable-surface-var-on-container);
    position: relative;
  }

  .message-actions :global(.message-action-button::after) {
    content: '';
    inset: calc(var(--space-200) * -1) -1px;
    position: absolute;
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
