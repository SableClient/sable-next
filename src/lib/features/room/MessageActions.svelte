<script lang="ts">
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';
  import EditIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import MoreIcon from 'phosphor-svelte/lib/DotsThreeIcon';
  import EmojiIcon from 'phosphor-svelte/lib/SmileyIcon';

  import { i18n } from '#lib/i18n.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import ReactionPicker from './ReactionPicker.svelte';
  import { messageMenuRows, type MessageActions } from './message-menu-items';

  type Props = MessageActions & {
    roomId?: string;
    onPickerOpenChange?: (open: boolean) => void;
    onOverflowOpenChange?: (open: boolean) => void;
  };

  let { roomId = '', onPickerOpenChange, onOverflowOpenChange, ...actions }: Props = $props();

  let rows = $derived(messageMenuRows(actions));
</script>

<div class="message-actions">
  {#if actions.onReact}
    <ReactionPicker
      label={$i18n.t('timeline.addReaction')}
      {roomId}
      onPick={actions.onReact}
      onOpenChange={onPickerOpenChange}
      triggerClass="btn btn-ghost btn-icon icon-button icon-button-small message-action-button"
    >
      <EmojiIcon />
    </ReactionPicker>
  {/if}
  {#if actions.onReply}
    <IconButton
      class="message-action-button"
      size="small"
      variant="ghost"
      label={$i18n.t('timeline.reply')}
      onclick={actions.onReply}
    >
      <ReplyIcon />
    </IconButton>
  {/if}
  {#if actions.onEdit}
    <IconButton
      class="message-action-button"
      size="small"
      variant="ghost"
      label={$i18n.t('timeline.editMessage')}
      onclick={actions.onEdit}
    >
      <EditIcon />
    </IconButton>
  {/if}
  {#if rows.length > 0}
    <ActionMenu label={$i18n.t('timeline.moreActions')} onOpenChange={onOverflowOpenChange}>
      {#snippet trigger({ props })}
        <IconButton
          {...props}
          size="small"
          variant="ghost"
          class="message-action-button selection-open"
          label={$i18n.t('timeline.moreActions')}
        >
          <MoreIcon />
        </IconButton>
      {/snippet}
      <IconContext values={{ 'aria-hidden': 'true' }}>
        {#each rows as row (row.key)}
          {@const RowIcon = row.icon}
          {#if row.separated}
            <ActionMenuSeparator />
          {/if}
          <ActionMenuItem
            class="menu-item-trailing-icon"
            destructive={row.destructive}
            onSelect={row.run}
          >
            <RowIcon />
            <span>{$i18n.t(row.label)}</span>
          </ActionMenuItem>
        {/each}
      </IconContext>
    </ActionMenu>
  {/if}
</div>

<style>
  .message-actions {
    --radius-outer: var(--radius);
    --radius-padding: var(--space-050);
    --radius-inner: max(0px, calc(var(--radius-outer) - var(--radius-padding)));

    align-items: center;
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius-outer);
    inset-inline-end: var(--space-300);
    bottom: calc(100% - var(--space-200));
    box-shadow: var(--shadow-float);
    display: flex;
    gap: var(--space-050);
    opacity: 0;
    padding: var(--radius-padding);
    pointer-events: none;
    position: absolute;
    z-index: 3;
  }

  .message-actions :global(.message-action-button) {
    --button-height: 1.5rem;

    border-radius: var(--radius-inner);
    color: var(--surface-var-on-container);
    position: relative;
  }

  .message-actions :global(.message-action-button::after) {
    content: '';
    inset: calc(var(--space-200) * -1) -1px;
    position: absolute;
  }

  .message-actions :global(button:focus-visible) {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: -1px;
  }

  @media (prefers-reduced-motion: no-preference) {
    .message-actions {
      transition: opacity var(--motion-normal) var(--motion-easing-standard);
    }
  }

  @media (hover: hover) and (pointer: fine) {
    .message-actions :global(button:hover) {
      background: var(--surface-var-container);
      color: var(--bg-on-container);
    }
  }
</style>
