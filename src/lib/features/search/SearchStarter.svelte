<script lang="ts">
  import { i18n } from '#lib/i18n.js';

  interface Props {
    onStart: (operator: string) => void;
    onShowAll: () => void;
  }

  let { onStart, onShowAll }: Props = $props();

  const STARTER_OPERATORS: readonly string[] = ['from', 'in', 'has', 'before', 'is'];
</script>

<div class="starter">
  <p class="hint">{i18n.t('search.hint')}</p>
  <ul class="starter-filters" aria-label={i18n.t('search.startFilter')}>
    {#each STARTER_OPERATORS as operator (operator)}
      <li>
        <button
          class="starter-filter"
          type="button"
          onclick={() => {
            onStart(operator);
          }}
        >
          {operator}:
        </button>
      </li>
    {/each}
    <li>
      <button class="starter-filter more" type="button" onclick={onShowAll}>
        {i18n.t('search.allFilters')}
      </button>
    </li>
  </ul>
  <p class="hint">{i18n.t('search.hintExample')}</p>
  <p class="hint">{i18n.t('search.hintSyntax')}</p>
</div>

<style>
  .starter {
    display: flex;
    flex-direction: column;
    gap: var(--space-300);
  }

  .starter-filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-150);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .starter-filter {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius-pill);
    color: var(--surface-on-container);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    min-block-size: var(--control-height-300);
    padding-inline: var(--space-300);
  }

  .starter-filter.more {
    background: none;
    border-style: dashed;
    color: var(--surface-var-on-container);
  }

  .starter-filter:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    .starter-filter:hover {
      background: var(--surface-container-hover);
    }
  }

  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  @media (pointer: coarse) {
    .starter-filter {
      position: relative;
    }

    .starter-filter::after {
      content: '';
      inset: calc((100% - var(--target-hit)) / 2) 0;
      position: absolute;
    }
  }
</style>
