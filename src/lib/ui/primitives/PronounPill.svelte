<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import {
    formatPronouns,
    pronounPillLength,
    pronounPillLimit,
    visiblePronouns,
  } from '#lib/personas/pronouns.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
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
      language: $i18n.resolvedLanguage ?? $i18n.language,
      filterByLanguage: preferences.filterPronounsByLanguage,
      limit: pronounPillLimit(preferences.pronounPillLimit),
      maxLength: pronounPillLength(preferences.pronounPillLength),
    })
  );
</script>

{#if splitPronouns.visible.length > 0}
  <span {...rest} class={['pronoun-pill-container', className]}>
    {#each splitPronouns.visible as pronoun, index (index)}
      <span class={['pronoun-pill', pillClass]} lang={pronoun.language ?? undefined}
        >{pronoun.summary}</span
      >
    {/each}
    {#if splitPronouns.overflow.length > 0}
      <span class={['pronoun-pill', pillClass]} title={formatPronouns(splitPronouns.overflow)}>
        {$i18n.t('timeline.morePronouns', {
          count: splitPronouns.overflow.length,
        })}
      </span>
    {/if}
  </span>
{/if}

<style>
  .pronoun-pill-container {
    display: inline-flex;
    flex-flow: row wrap;
    font-size: var(--font-size-x-small);
    gap: var(--space-050);
    height: 1rem;
    line-height: 1rem;
    overflow-y: clip;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pronoun-pill {
    background: var(--pronoun-pill-ground, var(--surface-var-container));
    border-radius: var(--radii-0);
    display: block;
    padding: 0 var(--space-050);
    position: relative;
    z-index: 0;
  }

  .pronoun-pill:not(:last-child)::before {
    background: inherit;
    border-radius: var(--radii-0);
    border-bottom-right-radius: var(--radii-pill);
    border-top-right-radius: var(--radii-pill);

    /* Hides visual element from screen readers */
    content: '...' / '';
    display: block;
    height: 1rem;
    line-height: 1rem;
    padding: 0 var(--space-050);
    padding-right: var(--space-150);
    position: absolute;
    right: -1.5em;
    z-index: -1;
  }

  .pronoun-pill:first-child {
    border-bottom-left-radius: var(--radii-pill);
    border-top-left-radius: var(--radii-pill);
    padding-left: var(--space-150);
  }

  .pronoun-pill:last-child {
    border-bottom-right-radius: var(--radii-pill);
    border-top-right-radius: var(--radii-pill);
    padding-right: var(--space-150);
  }
</style>
