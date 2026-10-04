<script lang="ts">
  import type { ImageUsageView, PackImageView } from '#src/generated/protocol';
  import { mergeProps, Popover } from 'bits-ui';
  import { tick, type Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { SvelteMap } from 'svelte/reactivity';
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
  import {
    isComposerSeparator,
    preferences,
    setPreference,
    type ComposerButton,
  } from '#lib/settings/preferences.svelte.js';
  import { createDragList, type DropInstruction, type DropState } from '#lib/ui/drag-list.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import EmoteBoard from '#lib/ui/primitives/EmoteBoard.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import type { BoardTab } from '#lib/ui/primitives/emote-board.js';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';

  interface Props {
    roomId: string;
    desktop: boolean;
    open?: boolean;
    tab?: BoardTab;
    query?: string;
    disabled?: boolean;
    reorderable?: boolean;
    ignoreGifAvailability?: boolean;
    onPick: (image: PackImageView, usage: ImageUsageView) => void;
    onPickUnicode: (emoji: string) => void;
    onPickGif?: (gif: GifResult) => void;
    onBeforeOpen?: () => void;
    extras?: Partial<Record<'persona' | 'format', Snippet<[onReorder: () => void]>>>;
  }

  let {
    roomId,
    desktop,
    open = $bindable(false),
    tab = $bindable<BoardTab>('emoticon'),
    query = $bindable(''),
    disabled = false,
    reorderable = false,
    ignoreGifAvailability = false,
    onPick,
    onPickUnicode,
    onPickGif,
    onBeforeOpen,
    extras = {},
  }: Props = $props();
  const reorderList = createDragList<ComposerButton>((left, right) => left === right);
  const dragSources = new SvelteMap<ComposerButton, ReturnType<typeof reorderList.draggable>>();
  const dropTargets = new SvelteMap<ComposerButton, ReturnType<typeof reorderList.dropTarget>>();
  let dragged = $state<ComposerButton | null>(null);
  let selectedForReorder = $state<ComposerButton | null>(null);
  let dropState = $state.raw<DropState<ComposerButton> | null>(null);
  let announcement = $state('');
  let config = $state.raw<GifsConfig | null>(null);
  let anchor = $state<HTMLElement | null>(null);
  const triggerElements = $state<Partial<Record<BoardTab, HTMLButtonElement>>>({});

  $effect(() => {
    if (open && anchor === null)
      anchor = triggerElements[tab] ?? triggerElements[boardTriggers[0]] ?? null;
  });

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

  let boardTriggers = $derived.by((): BoardTab[] => {
    const wanted = preferences.composerButtonOrder.filter(
      (id): id is BoardTab =>
        (id === 'gif' &&
          preferences.composerGifButton &&
          (ignoreGifAvailability || gifs !== null)) ||
        (id === 'sticker' && preferences.composerStickerButton) ||
        (id === 'emoticon' && preferences.composerEmoteButton)
    );
    return wanted.length > 0 ? wanted : ['emoticon'];
  });

  let triggers = $derived(
    preferences.composerButtonOrder.filter((id) =>
      isComposerSeparator(id)
        ? boardTriggers.length > 0
        : id === 'persona' || id === 'format'
          ? extras[id] !== undefined
          : boardTriggers.includes(id)
    )
  );

  const triggerIcons = { gif: GifIcon, sticker: StickerIcon, emoticon: SmileyIcon };

  function dragSource(id: ComposerButton): ReturnType<typeof reorderList.draggable> {
    let attachment = dragSources.get(id);
    if (!attachment) {
      attachment = reorderList.draggable(id, (next) => (dragged = next));
      dragSources.set(id, attachment);
    }
    return attachment;
  }

  function dropTarget(id: ComposerButton): ReturnType<typeof reorderList.dropTarget> {
    let attachment = dropTargets.get(id);
    if (!attachment) {
      attachment = reorderList.dropTarget(id, {
        axis: 'horizontal',
        onState: (next) => (dropState = next),
        onDrop: reorder,
      });
      dropTargets.set(id, attachment);
    }
    return attachment;
  }

  function triggerLabel(id: BoardTab): string {
    if (id === 'gif') return $i18n.t('composer.openGifPicker');
    if (id === 'sticker') return $i18n.t('composer.openStickerPicker');
    return $i18n.t('composer.emotesAndStickers');
  }

  function orderLabel(id: ComposerButton): string {
    if (isComposerSeparator(id)) return $i18n.t('settings.composerSeparator');
    if (id === 'persona') return $i18n.t('personas.picker');
    if (id === 'format') return $i18n.t('composer.formatting');
    if (id === 'gif') return $i18n.t('settings.composerChipLabels.composerGifButton');
    if (id === 'sticker') return $i18n.t('settings.composerChipLabels.composerStickerButton');
    return $i18n.t('settings.composerChipLabels.composerEmoteButton');
  }

  function buttonLabel(id: ComposerButton): string {
    if (reorderable || isComposerSeparator(id) || id === 'persona' || id === 'format')
      return orderLabel(id);
    return triggerLabel(id);
  }

  function reorder(
    source: ComposerButton,
    target: ComposerButton,
    instruction: DropInstruction
  ): void {
    if (source === target || instruction === 'into') return;

    const next = preferences.composerButtonOrder.filter((id) => id !== source);
    const targetIndex = next.indexOf(target);
    if (targetIndex < 0) return;
    next.splice(targetIndex + (instruction === 'below' ? 1 : 0), 0, source);
    setPreference('composerButtonOrder', next);

    const visible = next.filter((id) =>
      isComposerSeparator(id)
        ? boardTriggers.length > 0
        : id === 'persona' || id === 'format'
          ? extras[id] !== undefined
          : boardTriggers.includes(id)
    );
    announcement = $i18n.t('settings.composerOrderChanged', {
      name: orderLabel(source),
      position: visible.indexOf(source) + 1,
      total: visible.length,
    });
  }

  function reorderOnClick(id: ComposerButton): void {
    if (!reorderable) return;
    if (selectedForReorder === null) {
      selectedForReorder = id;
      announcement = $i18n.t('settings.composerOrderMoveSelected', { name: orderLabel(id) });
      return;
    }

    const source = selectedForReorder;
    selectedForReorder = null;
    if (source === id) {
      announcement = $i18n.t('settings.composerOrderMoveCancelled');
      return;
    }

    const instruction = triggers.indexOf(source) < triggers.indexOf(id) ? 'below' : 'above';
    reorder(source, id, instruction);
  }

  async function reorderWithKeyboard(event: KeyboardEvent, id: ComposerButton): Promise<void> {
    if (event.key === 'Escape' && selectedForReorder !== null) {
      event.preventDefault();
      selectedForReorder = null;
      announcement = $i18n.t('settings.composerOrderMoveCancelled');
      return;
    }
    if (!reorderable || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;

    const source = selectedForReorder ?? id;
    const index = triggers.indexOf(source);
    const offset = event.key === 'ArrowLeft' ? -1 : 1;
    const target = triggers[index + offset];
    if (target === undefined) return;

    event.preventDefault();
    reorder(source, target, offset < 0 ? 'above' : 'below');
    selectedForReorder = null;
    const control = event.target;
    await tick();
    if (control instanceof HTMLElement && control.isConnected) control.focus();
  }

  function openOn(id: BoardTab, element: HTMLElement): void {
    if (disabled || reorderable) return;
    if (open && tab === id) {
      open = false;
      return;
    }
    onBeforeOpen?.();
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

{#snippet boardButton(id: BoardTab, props: HTMLButtonAttributes)}
  {@const Icon = triggerIcons[id]}
  <button
    {...mergeProps(props as HTMLButtonAttributes & Record<string, unknown>, {
      onclick: (event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
        if (reorderable) reorderOnClick(id);
        else openOn(id, event.currentTarget);
      },
    })}
    bind:this={triggerElements[id]}
    type="button"
    class="composer-board-trigger selection-open"
    disabled={disabled && !reorderable}
    aria-pressed={reorderable ? selectedForReorder === id : undefined}
    aria-keyshortcuts={reorderable ? 'ArrowLeft ArrowRight Escape' : undefined}
    data-state={open && tab === id ? 'open' : 'closed'}
    aria-label={buttonLabel(id)}
    title={!desktop && reorderable
      ? $i18n.t('settings.composerButtonOrderDragHintNone')
      : undefined}
  >
    <Icon />
  </button>
{/snippet}

{#snippet boardSlot(id: ComposerButton)}
  <span
    class="composer-board-slot"
    role="presentation"
    class:is-separator={isComposerSeparator(id)}
    class:is-reorderable={reorderable}
    class:dragging={dragged === id}
    class:selected={selectedForReorder === id}
    class:drop-before={dropState?.item === id && dropState.instruction === 'above'}
    class:drop-after={dropState?.item === id && dropState.instruction === 'below'}
    onkeydown={(event) => reorderWithKeyboard(event, id)}
    {@attach reorderable ? dragSource(id) : undefined}
    {@attach reorderable ? dropTarget(id) : undefined}
  >
    {#if isComposerSeparator(id)}
      {#if reorderable}
        <button
          type="button"
          class="composer-separator-control"
          aria-label={orderLabel(id)}
          aria-pressed={selectedForReorder === id}
          aria-keyshortcuts="ArrowLeft ArrowRight Escape"
          onclick={() => reorderOnClick(id)}
        >
          <div class="composer-separator"></div>
        </button>
      {:else}
        <div class="composer-separator"></div>
      {/if}
    {:else if id === 'persona' || id === 'format'}
      {@render extras[id]?.(() => reorderOnClick(id))}
    {:else if desktop}
      <Tooltip
        label={reorderable ? $i18n.t('settings.composerButtonOrderDragHintNone') : buttonLabel(id)}
      >
        {#snippet trigger({ props })}{@render boardButton(id, props)}{/snippet}
      </Tooltip>
    {:else}
      {@render boardButton(id, {})}
    {/if}
  </span>
{/snippet}

{#snippet boardSlots()}
  {#each triggers as id (id)}
    {@render boardSlot(id)}
  {/each}
  {#if reorderable}<span class="sr-only" role="status">{announcement}</span>{/if}
{/snippet}

{#if desktop}
  <Popover.Root bind:open>
    {@render boardSlots()}
    <Popover.Portal>
      <Popover.Content
        class="composer-board"
        {...overlayLayer()}
        side="top"
        align="end"
        sideOffset={10}
        customAnchor={anchor}
      >
        <EmoteBoard
          {roomId}
          bind:tab
          bind:query
          resizable={true}
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
  {@render boardSlots()}
  <BottomSheet
    bind:open
    label={$i18n.t('composer.emotesAndStickers')}
    closeLabel={$i18n.t('composer.closeBoard')}
  >
    <EmoteBoard
      {roomId}
      bind:tab
      bind:query
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
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    :global(.composer-board-trigger:hover) {
      background: var(--surface-container-hover);
    }
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
  }

  :global(.composer-board-slot.is-separator) {
    align-items: center;
    display: flex;
    flex: 1 1 0;
    justify-content: center;
    min-width: var(--space-100);
  }

  .composer-separator-control {
    align-items: center;
    appearance: none;
    background: none;
    border: 0;
    color: inherit;
    cursor: inherit;
    display: flex;
    height: 100%;
    justify-content: center;
    padding: 0;
    width: 100%;
  }

  .composer-separator-control:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .composer-board-slot:not(.is-separator) {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    position: relative;
  }

  .composer-board-slot.is-reorderable {
    cursor: grab;
  }

  .composer-board-slot.is-reorderable:active {
    cursor: grabbing;
  }

  .composer-board-slot.is-reorderable:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .composer-board-slot.dragging {
    opacity: var(--opacity-disabled);
  }

  .composer-board-slot.selected {
    background: var(--primary-container);
    box-shadow: inset 0 0 0 var(--border-width-500) var(--primary-main);
  }

  .composer-board-slot.drop-before {
    box-shadow: inset var(--border-width-500) 0 0 var(--primary-main);
  }

  .composer-board-slot.drop-after {
    box-shadow: inset calc(-1 * var(--border-width-500)) 0 0 var(--primary-main);
  }

  :global(.composer-board-slot.is-reorderable button) {
    cursor: grab;
  }

  .sr-only {
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }
</style>
