<script lang="ts">
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';
  import ThreadIcon from 'phosphor-svelte/lib/ChatCircleDotsIcon';
  import EditIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import EmojiIcon from 'phosphor-svelte/lib/SmileyIcon';
  import ReceiptIcon from 'phosphor-svelte/lib/EyeIcon';

  import { i18n } from '#lib/i18n.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';

  import { readRecentReactions, rememberReaction } from '#lib/emoji/recents.js';
  import { shortcodeFor } from '#lib/emoji/emoji.js';

  interface Props {
    open?: boolean;
    preview?: string | null;
    onReact?: (emoji: string) => void;
    onViewReactions?: () => void;
    onReadReceipts?: () => void;
    onReply?: () => void;
    onEdit?: () => void;
    onDelete?: () => void;
    onCopyText?: () => void;
    onCopyLink?: () => void;
  }

  let {
    open = $bindable(false),
    preview = null,
    onReact,
    onViewReactions,
    onReadReceipts,
    onReply,
    onEdit,
    onDelete,
    onCopyText,
    onCopyLink,
  }: Props = $props();
  let quick = $derived(open ? readRecentReactions() : []);

  function run(action: (() => void) | undefined): void {
    open = false;
    action?.();
  }

  function react(emoji: string): void {
    rememberReaction(emoji);
    open = false;
    onReact?.(emoji);
  }
</script>

<BottomSheet
  bind:open
  label={$i18n.t('timeline.moreActions')}
  closeLabel={$i18n.t('timeline.closeMenu')}
>
  {#if preview}
    <p class="sheet-source">{preview}</p>
  {/if}
  {#if onReact}
    <div class="quick-strip" role="group" aria-label={$i18n.t('timeline.addReaction')}>
      {#each quick as emoji (emoji)}
        <Button
          variant="ghost"
          size="icon"
          class="quick-reaction"
          aria-label={shortcodeFor(emoji) ?? emoji}
          onclick={() => {
            react(emoji);
          }}>{emoji}</Button
        >
      {/each}
    </div>
  {/if}
  <div class="sheet-list">
    {#if onReply}
      <Button
        variant="ghost"
        class="sheet-action"
        onclick={() => {
          run(onReply);
        }}
      >
        <ReplyIcon />{$i18n.t('timeline.reply')}
      </Button>
      <Button
        variant="ghost"
        class="sheet-action"
        onclick={() => {
          run(onReply);
        }}
      >
        <ThreadIcon />{$i18n.t('timeline.replyInThread')}
      </Button>
    {/if}
    {#if onEdit}
      <Button
        variant="ghost"
        class="sheet-action"
        onclick={() => {
          run(onEdit);
        }}
      >
        <EditIcon />{$i18n.t('timeline.editMessage')}
      </Button>
    {/if}
    {#if onCopyText}
      <Button
        variant="ghost"
        class="sheet-action"
        onclick={() => {
          run(onCopyText);
        }}
      >
        <CopyIcon />{$i18n.t('timeline.copyMessage')}
      </Button>
    {/if}
    {#if onCopyLink}
      <Button
        variant="ghost"
        class="sheet-action"
        onclick={() => {
          run(onCopyLink);
        }}
      >
        <LinkIcon />{$i18n.t('timeline.copyLink')}
      </Button>
    {/if}
    {#if onViewReactions}
      <Button
        variant="ghost"
        class="sheet-action"
        onclick={() => {
          run(onViewReactions);
        }}
      >
        <EmojiIcon />{$i18n.t('timeline.viewReactions')}
      </Button>
    {/if}
    {#if onReadReceipts}
      <Button
        variant="ghost"
        class="sheet-action"
        onclick={() => {
          run(onReadReceipts);
        }}
      >
        <ReceiptIcon />{$i18n.t('timeline.readReceipts')}
      </Button>
    {/if}
    {#if onDelete}
      <Button
        variant="ghost"
        class="sheet-action danger"
        onclick={() => {
          run(onDelete);
        }}
      >
        <TrashIcon />{$i18n.t('timeline.deleteMessage')}
      </Button>
    {/if}
  </div>
</BottomSheet>

<style>
  .quick-strip {
    display: grid;
    gap: 2px;
    grid-template-columns: repeat(auto-fit, minmax(2.25rem, 1fr));
    padding: 0 var(--space-2) var(--space-2);
  }

  :global(.quick-reaction) {
    background: var(--sable-surface-var-container);
    border-color: transparent;
    font-size: var(--font-size-large);
    line-height: 1;
  }

  .sheet-source {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0 0 var(--space-1);
    overflow: hidden;
    padding: 0 var(--space-3);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sheet-list {
    display: grid;
  }

  :global(.sheet-action) {
    color: var(--sable-surface-on-container);
    min-height: var(--control-height-large);
    padding: 0 var(--space-3);
    text-align: left;
    width: 100%;
  }

  :global(.sheet-action:active:not(:disabled)) {
    background: var(--sable-surface-container-active);
  }

  :global(.sheet-action.danger) {
    color: var(--sable-crit-main);
  }

  .sheet-list :global(svg) {
    flex: 0 0 auto;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }
</style>
