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
  import { setContext, untrack } from 'svelte';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import { createMasterDetail } from '#lib/ui/master-detail.svelte.js';
  import { shouldReduceMotion } from '#lib/ui/motion.js';
  import { SwipeBack } from '#lib/ui/swipe-back.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import { settingsChoices } from '#lib/ui/primitives/Switcher.svelte';
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
  setContext(settingsChoices, true);
  const SWIPE_IGNORE = '.slider, [data-sheet-no-drag]';
  const outline = new OutlineTracker();
  const pages = createMasterDetail(
    () => section,
    () => fallback()
  );
  let activeLabel = $derived(pages.openSection ? sectionLabel(pages.openSection) : label);

  let content = $state<HTMLElement | null>(null);
  let list = $state<HTMLElement | null>(null);
  let entering = $state(false);
  let shownSection: string | null = untrack(() => pages.openSection);
  const pageSwipe = new SwipeBack({
    width: () => content?.clientWidth ?? 0,
    onDismiss: () => onBack(),
    ignore: SWIPE_IGNORE,
  });
  const listSwipe = new SwipeBack({
    width: () => list?.clientWidth ?? 0,
    onDismiss: () => onClose(),
    ignore: SWIPE_IGNORE,
    slideOut: false,
  });
  let revealed = $derived(pageSwipe.moved || entering);
  let listSwipeable = $derived(!pages.desktop && !(pages.showContent && pages.openSection));

  $effect(() => {
    const next = pages.openSection;
    const desktop = pages.desktop;
    untrack(() => {
      pageSwipe.reset();
      entering = !desktop && shownSection === null && next !== null && !shouldReduceMotion();
      shownSection = next;
    });
  });
</script>

{#snippet currentOutline(entry: { label: string })}
  {#if outline.entries.length > 0}
    <SettingsOutline {outline} label={$i18n.t('settings.outlineLabel', { section: entry.label })} />
  {/if}
{/snippet}

<div class="settings-shell" class:paged={!pages.desktop}>
  <Dialog.Description class="screen-reader-only">{description}</Dialog.Description>

  {#if pages.showList || revealed}
    <aside
      class="settings-nav"
      class:settings-nav-paged={!pages.desktop}
      class:swiping={listSwipe.swiping}
      aria-label={label}
      style:transform={listSwipe.transform}
      bind:this={list}
      ontouchstart={listSwipeable ? listSwipe.start : undefined}
      ontouchmove={listSwipeable ? listSwipe.move : undefined}
      ontouchend={listSwipeable ? () => listSwipe.finish(false) : undefined}
      ontouchcancel={listSwipeable ? () => listSwipe.finish(true) : undefined}
    >
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
      class:swiping={pageSwipe.swiping}
      class:swiped={revealed}
      class:entering
      style:transform={pageSwipe.transform}
      bind:this={content}
      ontouchstart={pages.desktop ? undefined : pageSwipe.start}
      ontouchmove={pages.desktop ? undefined : pageSwipe.move}
      ontouchend={pages.desktop ? undefined : () => pageSwipe.finish(false)}
      ontouchcancel={pages.desktop ? undefined : () => pageSwipe.finish(true)}
      onanimationend={(event) => {
        if (event.target === event.currentTarget) entering = false;
      }}
    >
      {#if !pages.desktop}
        <div class="settings-title section-bar settings-nav-header">
          <IconButton variant="ghost" size="small" label={backLabel} onclick={pageSwipe.dismiss}
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
    color: var(--surface-on-container);
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
    will-change: transform;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .paged .settings-content:not(.swiping),
    :global(html:not([data-reduced-motion='on'])) .settings-nav-paged:not(.swiping) {
      transition: transform var(--duration-medium) var(--ease-slide);
    }

    :global(html:not([data-reduced-motion='on'])) .paged .settings-content.entering {
      animation: page-in var(--duration-medium) var(--ease-slide);
    }
  }

  @keyframes page-in {
    from {
      transform: translateX(100%);
    }
  }

  .settings-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .section-bar {
    background: var(--surface-container);
    border-bottom: var(--border-width) solid var(--surface-container-line);
    color: var(--surface-on-container);
    flex: 0 0 auto;
    gap: var(--space-150);
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
