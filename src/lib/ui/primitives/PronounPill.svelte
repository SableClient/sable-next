<script lang="ts">
  import { currentLocale, i18n } from '#lib/i18n.js';
  import {
    fittingPillCount,
    formatPronouns,
    pronounPillLength,
    pronounPillLimit,
    visiblePronouns,
  } from '#lib/personas/pronouns.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import type { ClassValue, HTMLAttributes } from 'svelte/elements';
  import type { PronounView } from '#src/generated/protocol';

  type Props = Omit<HTMLAttributes<HTMLSpanElement>, 'class' | 'children'> & {
    class?: ClassValue;
    pillClass?: ClassValue;
    pronouns: readonly PronounView[];
  };

  let { class: className = '', pillClass = '', pronouns, ...rest }: Props = $props();

  let splitPronouns = $derived(
    visiblePronouns(pronouns, {
      language: currentLocale(),
      filterByLanguage: preferences.filterPronounsByLanguage,
      limit: pronounPillLimit(preferences.pronounPillLimit),
      maxLength: pronounPillLength(preferences.pronounPillLength),
    })
  );

  let container = $state<HTMLElement>();
  let sizer = $state<HTMLElement>();
  let probe = $state<HTMLElement>();
  let fitted = $state(Number.POSITIVE_INFINITY);

  let total = $derived(splitPronouns.visible.length + splitPronouns.overflow.length);
  let shown = $derived(Math.min(fitted, splitPronouns.visible.length));
  let hidden = $derived([...splitPronouns.visible.slice(shown), ...splitPronouns.overflow]);
  let probeLabel = $derived(i18n.t('timeline.morePronouns', { count: total }));

  function measure() {
    if (!container || !sizer || !probe) return;
    const widths = Array.from(sizer.children, (pill) => pill.getBoundingClientRect().width);
    const pulledIn = Math.min(
      0,
      Number.parseFloat(getComputedStyle(container).marginInlineStart) || 0
    );
    fitted = fittingPillCount(
      widths,
      probe.getBoundingClientRect().width,
      Number.parseFloat(getComputedStyle(sizer).columnGap) || 0,
      container.getBoundingClientRect().width + pulledIn + 0.5,
      splitPronouns.overflow.length > 0
    );
  }

  $effect(() => {
    if (!container || !sizer || !probe) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(sizer);
    observer.observe(probe);
    return () => {
      observer.disconnect();
    };
  });
</script>

{#if splitPronouns.visible.length > 0}
  <span
    {...rest}
    class={['pronoun-pill-container', { empty: shown === 0 }, className]}
    bind:this={container}
  >
    <span class="pronoun-pill-sizer" aria-hidden="true" bind:this={sizer}>
      {#each splitPronouns.visible as pronoun, index (index)}
        <span class="pronoun-pill" lang={pronoun.language ?? undefined} data-text={pronoun.summary}
        ></span>
      {/each}
    </span>
    <span
      class="pronoun-pill pronoun-pill-probe"
      aria-hidden="true"
      bind:this={probe}
      data-text={probeLabel}
    ></span>
    <span class="pronoun-pill-row">
      {#each splitPronouns.visible.slice(0, shown) as pronoun, index (index)}
        <span class={['pronoun-pill', pillClass]} lang={pronoun.language ?? undefined}
          >{pronoun.summary}</span
        >
      {/each}
      {#if shown > 0 && hidden.length > 0}
        <Tooltip label={formatPronouns(hidden)}>
          {#snippet trigger({ props })}
            <span {...props} class={['pronoun-pill', pillClass]}>
              {i18n.t('timeline.morePronouns', { count: hidden.length })}
            </span>
          {/snippet}
        </Tooltip>
      {/if}
    </span>
  </span>
{/if}

<style>
  .pronoun-pill-container {
    display: inline-grid;
    font-size: var(--font-size-x-small);
    height: 1rem;
    line-height: 1rem;
    min-width: 0;
    overflow: hidden;
    position: relative;
  }

  /* Still measured, but its leftover space moves to the end of the row. */
  .pronoun-pill-container.empty {
    order: 1;
  }

  .pronoun-pill-sizer,
  .pronoun-pill-row {
    display: flex;
    gap: var(--space-050);
    grid-area: 1 / 1;
    min-width: 0;
    white-space: nowrap;
  }

  .pronoun-pill-sizer {
    overflow: hidden;
    pointer-events: none;
    visibility: hidden;
  }

  .pronoun-pill-probe {
    pointer-events: none;
    position: absolute;
    visibility: hidden;
  }

  .pronoun-pill {
    background: var(--pronoun-pill-ground, var(--surface-var-container));
    border-radius: var(--radii-0);
    display: block;
    flex: none;
    padding: 0 var(--space-100);
    white-space: nowrap;
  }

  .pronoun-pill[data-text]::before {
    content: attr(data-text);
  }

  .pronoun-pill-row > :first-child {
    border-bottom-left-radius: var(--radii-pill);
    border-top-left-radius: var(--radii-pill);
  }

  .pronoun-pill-row > :last-child {
    border-bottom-right-radius: var(--radii-pill);
    border-top-right-radius: var(--radii-pill);
  }
</style>
