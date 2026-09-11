<script lang="ts">
  import type { ImageUsageView, PackImageView } from '#src/generated/protocol';
  import { Popover } from 'bits-ui';
  import GifIcon from 'phosphor-svelte/lib/GifIcon';
  import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
  import StickerIcon from 'phosphor-svelte/lib/StickerIcon';

  import { runtimeConfig } from '#lib/config/runtime-config.js';
  import { rememberGif } from '#lib/features/gif/favorites.svelte.js';
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
  let anchor = $state<HTMLElement | null>(null);

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

  let triggers = $derived.by(() => {
    const wanted = [
      preferences.composerGifButton && gifs ? ('gif' as const) : null,
      preferences.composerStickerButton ? ('sticker' as const) : null,
      preferences.composerEmoteButton ? ('emoticon' as const) : null,
    ].filter((id) => id !== null);
    return wanted.length > 0 ? wanted : (['emoticon'] as const);
  });

  const triggerIcons = { gif: GifIcon, sticker: StickerIcon, emoticon: SmileyIcon };

  function triggerLabel(id: BoardTab): string {
    if (id === 'gif') return $i18n.t('composer.openGifPicker');
    if (id === 'sticker') return $i18n.t('composer.openStickerPicker');
    return $i18n.t('composer.emotesAndStickers');
  }

  function openOn(id: BoardTab, element: HTMLElement): void {
    if (open && tab === id) {
      open = false;
      return;
    }
    anchor = element;
    tab = id;
    open = true;
  }

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
    rememberGif(gif);
    onPickGif?.(gif);
  }
</script>

{#if desktop}
  <Popover.Root bind:open>
    {#each triggers as id (id)}
      {@const Icon = triggerIcons[id]}
      <button
        type="button"
        class="composer-board-trigger selection-open"
        {disabled}
        data-state={open && tab === id ? 'open' : 'closed'}
        aria-label={triggerLabel(id)}
        onclick={(event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
          openOn(id, event.currentTarget);
        }}
      >
        <Icon />
      </button>
    {/each}
    <Popover.Portal>
      <Popover.Content
        class="composer-board"
        side="top"
        align="end"
        sideOffset={10}
        customAnchor={anchor}
      >
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
  {#each triggers as id (id)}
    {@const Icon = triggerIcons[id]}
    <button
      type="button"
      class="composer-board-trigger selection-open"
      {disabled}
      data-state={open && tab === id ? 'open' : 'closed'}
      aria-label={triggerLabel(id)}
      onpointerdown={onBeforeOpen}
      onclick={() => {
        if (open && tab === id) {
          open = false;
          return;
        }
        tab = id;
        open = true;
      }}
    >
      <Icon />
    </button>
  {/each}
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
    color: var(--surface-var-on-container);
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
    background: var(--surface-container-hover);
  }

  :global(.composer-board-trigger:disabled) {
    color: var(--sec-main);
    cursor: default;
  }

  :global(.composer-board-trigger svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.composer-board) {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    color: var(--surface-on-container);
    overflow: hidden;
    z-index: var(--layer-popover);
  }
</style>
