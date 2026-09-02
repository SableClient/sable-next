<script lang="ts">
  import type { ImageUsageView } from '#src/generated/ImageUsageView';
  import type { PackImageView } from '#src/generated/PackImageView';
  import { Popover } from 'bits-ui';
  import StickerIcon from 'phosphor-svelte/lib/StickerIcon';

  import { runtimeConfig } from '#lib/config/runtime-config.js';
  import {
    gifSearchAvailable,
    type GifResult,
    type GifsConfig,
  } from '#lib/features/gif/providers.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import EmoteBoard from '#lib/ui/primitives/EmoteBoard.svelte';
  import type { BoardTab } from '#lib/ui/primitives/emote-board.js';

  interface Props {
    roomId: string;
    desktop: boolean;
    open?: boolean;
    tab?: BoardTab;
    query?: string;
    disabled?: boolean;
    onPick: (image: PackImageView, usage: ImageUsageView) => void;
    onPickUnicode: (emoji: string) => void;
    onPickGif?: (gif: GifResult) => void;
    onBeforeOpen?: () => void;
  }

  let {
    roomId,
    desktop,
    open = $bindable(false),
    tab = $bindable<BoardTab>('emoticon'),
    query = $bindable(''),
    disabled = false,
    onPick,
    onPickUnicode,
    onPickGif,
    onBeforeOpen,
  }: Props = $props();
  let config = $state.raw<GifsConfig | null>(null);

  $effect(() => {
    let cancelled = false;
    void runtimeConfig().then((loaded) => {
      if (!cancelled) config = loaded.gifs;
    });
    return () => {
      cancelled = true;
    };
  });

  let gifs = $derived(
    onPickGif && config && gifSearchAvailable(config, preferences.gifProvider)
      ? { config, providerSetting: preferences.gifProvider }
      : null
  );

  function pick(image: PackImageView, usage: ImageUsageView): void {
    open = false;
    onPick(image, usage);
  }

  function pickUnicode(emoji: string): void {
    open = false;
    onPickUnicode(emoji);
  }

  function pickGif(gif: GifResult): void {
    open = false;
    onPickGif?.(gif);
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
        <EmoteBoard
          {roomId}
          bind:tab
          bind:query
          resizable
          unicode
          {gifs}
          onPick={pick}
          onPickUnicode={pickUnicode}
          onPickGif={pickGif}
        />
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
      {gifs}
      onPick={pick}
      onPickUnicode={pickUnicode}
      onPickGif={pickGif}
    />
  </BottomSheet>
{/if}

<style>
  :global(.composer-board-trigger) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: flex;
    flex: 0 0 auto;
    height: var(--target);
    justify-content: center;
    position: relative;
    width: var(--target);
  }

  :global(.composer-board-trigger)::after {
    border-radius: inherit;
    content: '';
    inset: 0;
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
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    color: var(--sable-surface-on-container);
    overflow: hidden;
    z-index: var(--layer-popover);
  }
</style>
