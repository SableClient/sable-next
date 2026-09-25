<script lang="ts" module>
  import type { Snippet } from 'svelte';

  export interface SettingsShellNav {
    desktop: boolean;
    openSection: string | null;
    current: Snippet<[{ label: string }]> | undefined;
  }
</script>

<script lang="ts">
  import { Dialog } from 'bits-ui';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import { createMasterDetail } from '#lib/ui/master-detail.svelte.js';
  import { shouldReduceMotion } from '#lib/ui/motion.js';
  import {
    finishSwipeGesture,
    startSwipeGesture,
    updateSwipeGesture,
    type SwipeGesture,
  } from '#lib/ui/swipe-gesture.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsJumpSheet from './SettingsJumpSheet.svelte';
  import SettingsOutline from './SettingsOutline.svelte';
  import { OutlineTracker } from './settings-outline.svelte.js';

  interface Props {
    section: string | null;
    fallback: () => string | null;
    label: string;
    description: string;
    closeLabel: string;
    backLabel: string;
    sectionLabel: (section: string) => string;
    heading: Snippet;
    nav: Snippet<[SettingsShellNav]>;
    content: Snippet<[string]>;
    onBack: () => void;
    onClose: () => void;
  }

  let {
    section,
    fallback,
    label,
    description,
    closeLabel,
    backLabel,
    sectionLabel,
    heading,
    nav,
    content: renderContent,
    onBack,
    onClose,
  }: Props = $props();
  const SWIPE_IGNORE = '.slider, [data-sheet-no-drag]';
  const outline = new OutlineTracker();
  const pages = createMasterDetail(
    () => section,
    () => fallback()
  );
  let activeLabel = $derived(pages.openSection ? sectionLabel(pages.openSection) : label);

  let swipe: SwipeGesture | undefined;
  let swipeOffset = $state(0);
  let swiping = $state(false);
  let revealed = $state(false);
  let content = $state<HTMLElement | null>(null);

  function startSwipe(event: TouchEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    swipe = target?.closest(SWIPE_IGNORE) ? undefined : startSwipeGesture(event, 0);
  }

  function moveSwipe(event: TouchEvent): void {
    if (!swipe) return;
    const update = updateSwipeGesture(swipe, event);
    if (!update || update.mode !== 'horizontal') return;
    swiping = true;
    revealed = true;
    swipeOffset = Math.max(0, update.distanceX);
  }

  function finishSwipe(cancelled: boolean): void {
    const active = swipe;
    swipe = undefined;
    swiping = false;
    if (!active) return;
    const offset = swipeOffset;
    swipeOffset = 0;
    const result = finishSwipeGesture(active, offset, cancelled);
    if (!result.handled) return;
    const width = content?.clientWidth ?? 0;
    if (result.direction === 'right' || (result.direction === undefined && offset > width / 2)) {
      revealed = false;
      onBack();
      return;
    }
    if (offset === 0 || shouldReduceMotion()) revealed = false;
  }
</script>

{#snippet currentOutline(entry: { label: string })}
  {#if outline.entries.length > 0}
    <SettingsOutline {outline} label={$i18n.t('settings.outlineLabel', { section: entry.label })} />
  {/if}
{/snippet}

<div class="settings-shell" class:paged={!pages.desktop}>
  <Dialog.Description class="screen-reader-only">{description}</Dialog.Description>

  {#if pages.showList || revealed}
    <aside class="settings-nav" class:settings-nav-paged={!pages.desktop} aria-label={label}>
      <div class="settings-title settings-nav-header">
        <Dialog.Title class="settings-heading">{@render heading()}</Dialog.Title>
        <IconButton variant="ghost" size="small" label={closeLabel} onclick={onClose}
          ><XIcon /></IconButton
        >
      </div>
      {@render nav({
        desktop: pages.desktop,
        openSection: pages.openSection,
        current: pages.desktop ? currentOutline : undefined,
      })}
    </aside>
  {/if}

  {#if pages.showContent && pages.openSection}
    <section
      class="settings-content"
      aria-label={activeLabel}
      class:swiping
      class:swiped={revealed}
      style:transform={swipeOffset > 0 ? `translateX(${String(swipeOffset)}px)` : undefined}
      bind:this={content}
      ontouchstart={pages.desktop ? undefined : startSwipe}
      ontouchmove={pages.desktop ? undefined : moveSwipe}
      ontouchend={pages.desktop ? undefined : () => finishSwipe(false)}
      ontouchcancel={pages.desktop ? undefined : () => finishSwipe(true)}
      ontransitionend={(event) => {
        if (event.target === event.currentTarget && !swiping) revealed = false;
      }}
    >
      {#if !pages.desktop}
        <div class="settings-title section-bar settings-nav-header">
          <IconButton variant="ghost" size="small" label={backLabel} onclick={onBack}
            ><ArrowLeftIcon /></IconButton
          >
          <Dialog.Title class="settings-heading">
            {#if outline.entries.length > 1}
              <SettingsJumpSheet {outline} title={activeLabel} />
            {:else}
              {activeLabel}
            {/if}
          </Dialog.Title>
          <IconButton variant="ghost" size="small" label={closeLabel} onclick={onClose}
            ><XIcon /></IconButton
          >
        </div>
      {/if}
      {#key pages.openSection}
        <div class="settings-scroll" {@attach outline.track}>
          {@render renderContent(pages.openSection)}
        </div>
      {/key}
    </section>
  {/if}
</div>

<style>
  .settings-shell {
    background: var(--bg-container);
    color: var(--bg-on-container);
    display: flex;
    height: 100%;
    min-height: 0;
    width: 100%;
  }

  :global(.settings-heading) {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    line-height: var(--line-height-heading);
    margin: 0;
    min-width: 0;
    padding: 0;
  }

  .settings-nav-header :global(.settings-heading) {
    flex: 1;
  }

  .settings-content {
    --ghost-hover: var(--surface-container-hover);
    --ghost-active: var(--surface-container-active);

    background: var(--surface-container);
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    width: 100%;
  }

  .paged {
    position: relative;
  }

  .paged .settings-content.swiped {
    box-shadow: var(--shadow-dialog);
    inset: 0;
    position: absolute;
  }

  .paged .settings-content:not(.swiping) {
    transition: transform var(--duration-fast) var(--ease-smooth-out);
  }

  .settings-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .section-bar {
    background: var(--surface-container);
    border-bottom: var(--border-width) solid var(--surface-container-line);
    flex: 0 0 auto;
    gap: var(--space-300);
    justify-content: flex-start;
  }

  .section-bar :global(.settings-heading) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .paged .settings-scroll :global(.app-page-header) {
    padding-inline: var(--space-400);
  }

  .paged .settings-scroll :global(.app-page-header h1) {
    border: 0;
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    padding: 0;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }
</style>
