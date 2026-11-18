<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { slide } from 'svelte/transition';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon';

  import type { TimelineItemView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { motionMs, MOTION_MS } from '#lib/ui/motion.js';
  import './text-button.css';
  import ResponsiveInfoDialog from '#lib/ui/primitives/ResponsiveInfoDialog.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  interface Props {
    items: readonly TimelineItemView[];
    renderItem: Snippet<[TimelineItemView]>;
  }

  let { items, renderItem }: Props = $props();
  const eventsId = $props.id();
  let expanded = $state(false);
  let detailsOpen = $state(false);
  let toggleLabel = $derived(
    expanded
      ? i18n.t('timeline.beforeJoinGroup.hide')
      : i18n.t('timeline.beforeJoinGroup.show', { count: items.length })
  );
</script>

<p class="before-join-group">
  <Tooltip label={toggleLabel}>
    {#snippet trigger({ props })}
      <button
        {...props}
        class="state-icon expand-events"
        type="button"
        aria-label={toggleLabel}
        aria-expanded={expanded}
        aria-controls={eventsId}
        onclick={() => {
          expanded = !expanded;
        }}
      >
        <CaretDownIcon aria-hidden="true" />
      </button>
    {/snippet}
  </Tooltip>
  <span class="text">
    <span class="summary"
      >{i18n.t('timeline.beforeJoinGroup.summary', { count: items.length })}</span
    ><span class="why-wrap"
      ><span aria-hidden="true">·&nbsp;</span><button
        type="button"
        class="text-button"
        aria-haspopup="dialog"
        onclick={() => {
          detailsOpen = true;
        }}>{i18n.t('timeline.beforeJoinGroup.why')}</button
      ></span
    >
  </span>
</p>

<div id={eventsId} inert={!expanded}>
  {#if expanded}
    <div
      class="before-join-events"
      transition:slide={{ duration: motionMs(MOTION_MS.fast), easing: cubicOut }}
    >
      {#each items as item (item.id)}
        {@render renderItem(item)}
      {/each}
    </div>
  {/if}
</div>

<ResponsiveInfoDialog
  bind:open={detailsOpen}
  label={i18n.t('timeline.utd.title.sentBeforeWeJoined')}
  closeLabel={i18n.t('common.close')}
>
  {#snippet header()}
    <ProhibitIcon />
    <h2>{i18n.t('timeline.utd.title.sentBeforeWeJoined')}</h2>
  {/snippet}

  {#snippet body()}
    <p>{i18n.t('timeline.utd.details.sentBeforeWeJoined')}</p>
    <h3>{i18n.t('timeline.utd.causeHeader')}</h3>
    <p>{i18n.t('timeline.utd.cause.sentBeforeWeJoined')}</p>
  {/snippet}
</ResponsiveInfoDialog>

<style>
  .before-join-group {
    align-items: start;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-body);
    gap: var(--timeline-row-gap);
    line-height: var(--line-height-body);
    margin: 0;
    opacity: var(--opacity-p300);
  }

  .text {
    flex: 1;
    min-width: 0;
  }

  .summary {
    overflow-wrap: anywhere;
  }

  .why-wrap {
    display: inline-block;
    margin-inline-start: var(--space-100);
  }

  .state-icon {
    align-items: center;
    display: flex;
    flex: 0 0 var(--avatar-size-small);
    justify-content: center;
  }

  .state-icon :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .expand-events {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    min-height: var(--space-600);
    padding: 0;
  }

  .expand-events[aria-expanded='false'] :global(svg) {
    transform: rotate(-90deg);
  }

  @media (prefers-reduced-motion: no-preference) {
    .expand-events :global(svg) {
      transition: transform var(--duration-fast) var(--ease-smooth-out);
    }
  }

  .expand-events:is(:hover, :focus-visible) {
    background: var(--surface-var-container-hover);
    border-radius: var(--radii-200);
  }

  .expand-events:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--space-050);
  }

  .before-join-events {
    display: grid;
    gap: var(--space-100);
    margin-block-start: var(--space-100);
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  h3 {
    font-size: var(--font-size-label);
    margin: 0;
  }
</style>
