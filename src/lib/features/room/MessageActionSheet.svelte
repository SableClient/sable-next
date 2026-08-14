<script lang="ts">
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';
  import ThreadIcon from 'phosphor-svelte/lib/ChatCircleDotsIcon';
  import EditIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { i18n } from '$lib/i18n';
  import BottomSheet from '$lib/ui/primitives/BottomSheet.svelte';

  interface Props {
    open?: boolean;
    preview?: string | null;
    onReply?: () => void;
    onEdit?: () => void;
    onDelete?: () => void;
    onCopyText?: () => void;
    onCopyLink?: () => void;
  }

  let {
    open = $bindable(false),
    preview = null,
    onReply,
    onEdit,
    onDelete,
    onCopyText,
    onCopyLink,
  }: Props = $props();

  function run(action: (() => void) | undefined): void {
    open = false;
    action?.();
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
  <div class="sheet-list">
    {#if onReply}
      <button
        type="button"
        onclick={() => {
          run(onReply);
        }}
      >
        <ReplyIcon />{$i18n.t('timeline.reply')}
      </button>
      <button
        type="button"
        onclick={() => {
          run(onReply);
        }}
      >
        <ThreadIcon />{$i18n.t('timeline.replyInThread')}
      </button>
    {/if}
    {#if onEdit}
      <button
        type="button"
        onclick={() => {
          run(onEdit);
        }}
      >
        <EditIcon />{$i18n.t('timeline.editMessage')}
      </button>
    {/if}
    {#if onCopyText}
      <button
        type="button"
        onclick={() => {
          run(onCopyText);
        }}
      >
        <CopyIcon />{$i18n.t('timeline.copyMessage')}
      </button>
    {/if}
    {#if onCopyLink}
      <button
        type="button"
        onclick={() => {
          run(onCopyLink);
        }}
      >
        <LinkIcon />{$i18n.t('timeline.copyLink')}
      </button>
    {/if}
    {#if onDelete}
      <button
        class="danger"
        type="button"
        onclick={() => {
          run(onDelete);
        }}
      >
        <TrashIcon />{$i18n.t('timeline.deleteMessage')}
      </button>
    {/if}
  </div>
</BottomSheet>

<style>
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

  .sheet-list button {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--sable-surface-on-container);
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: var(--space-2);
    min-height: var(--control-height-large);
    padding: 0 var(--space-3);
    text-align: left;
    width: 100%;
  }

  .sheet-list button:active {
    background: var(--sable-surface-container-active);
  }

  .sheet-list .danger {
    color: var(--sable-crit-main);
  }

  .sheet-list :global(svg) {
    flex: 0 0 auto;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }
</style>
