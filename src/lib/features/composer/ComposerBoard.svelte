<script lang="ts">
  import type { ImageUsageView } from '@/generated/ImageUsageView';
  import type { PackImageView } from '@/generated/PackImageView';
  import { Popover } from 'bits-ui';
  import StickerIcon from 'phosphor-svelte/lib/StickerIcon';

  import { i18n } from '$lib/i18n';
  import BottomSheet from '$lib/ui/primitives/BottomSheet.svelte';
  import EmoteBoard from '$lib/ui/primitives/EmoteBoard.svelte';

  interface Props {
    roomId: string;
    desktop: boolean;
    disabled?: boolean;
    onPick: (image: PackImageView, usage: ImageUsageView) => void;
    onPickUnicode: (emoji: string) => void;
    onBeforeOpen?: () => void;
  }

  let { roomId, desktop, disabled = false, onPick, onPickUnicode, onBeforeOpen }: Props = $props();
  let open = $state(false);
  let tab = $state<ImageUsageView>('emoticon');

  function pick(image: PackImageView, usage: ImageUsageView): void {
    open = false;
    onPick(image, usage);
  }

  function pickUnicode(emoji: string): void {
    open = false;
    onPickUnicode(emoji);
  }
</script>

{#if desktop}
  <Popover.Root bind:open>
    <Popover.Trigger
      class="composer-board-trigger"
      {disabled}
      aria-label={$i18n.t('composer.emotesAndStickers')}
    >
      <StickerIcon />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content class="composer-board" side="top" align="end" sideOffset={10}>
        <EmoteBoard {roomId} bind:tab unicode onPick={pick} onPickUnicode={pickUnicode} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{:else}
  <button
    type="button"
    class="composer-board-trigger"
    {disabled}
    aria-label={$i18n.t('composer.emotesAndStickers')}
    onpointerdown={onBeforeOpen}
    onclick={() => {
      open = true;
    }}
  >
    <StickerIcon />
  </button>
  <BottomSheet
    bind:open
    label={$i18n.t('composer.emotesAndStickers')}
    closeLabel={$i18n.t('composer.closeBoard')}
  >
    <EmoteBoard
      {roomId}
      bind:tab
      variant="sheet"
      unicode
      onPick={pick}
      onPickUnicode={pickUnicode}
    />
  </BottomSheet>
{/if}

<style>
  :global(.composer-board-trigger) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    bottom: 1px;
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: flex;
    height: var(--target);
    justify-content: center;
    position: absolute;
    right: 0.25rem;
    width: var(--target);
  }

  :global(.composer-board-trigger)::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  :global(.composer-board-trigger:hover) {
    background: var(--sable-surface-container-hover);
  }

  :global(.composer-board-trigger[data-state='open']) {
    background: var(--sable-surface-container-active);
    color: var(--sable-primary-main);
  }

  :global(.composer-board-trigger:disabled) {
    color: var(--sable-sec-main);
    cursor: default;
  }

  :global(.composer-board-trigger svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.composer-board) {
    background: var(--sable-surface-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    color: var(--sable-surface-on-container);
    overflow: hidden;
    z-index: var(--layer-popover);
  }
</style>
