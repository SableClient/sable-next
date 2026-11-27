<script lang="ts">
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';

  import { i18n } from '#lib/i18n.js';
  import {
    DEBUG_LOG_CATEGORIES,
    debugLog,
    setDebugCategoryEnabled,
  } from '#lib/observability/debug-log.svelte.js';

  let kept = $derived(
    DEBUG_LOG_CATEGORIES.filter((category) => !debugLog.disabledCategories.has(category)).length
  );
</script>

<details class="settings-form breadcrumbs">
  <summary>
    <CaretRightIcon class="caret" aria-hidden="true" />
    {i18n.t('settings.developerBreadcrumbsSummary', {
      count: kept,
      total: DEBUG_LOG_CATEGORIES.length,
    })}
  </summary>
  <p>{i18n.t('settings.developerSentryDescription')}</p>
  <fieldset>
    <legend class="screen-reader-only">{i18n.t('settings.developerSentryTitle')}</legend>
    {#each DEBUG_LOG_CATEGORIES as category (category)}
      <label>
        <input
          type="checkbox"
          checked={!debugLog.disabledCategories.has(category)}
          onchange={(event) => setDebugCategoryEnabled(category, event.currentTarget.checked)}
        />
        {i18n.t(`settings.developerLogCategories.${category}`)}
      </label>
    {/each}
  </fieldset>
</details>

<style>
  .breadcrumbs {
    display: grid;
    gap: var(--space-300);
  }

  summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    font-weight: var(--font-weight-medium);
    gap: var(--space-200);
    list-style: none;
    padding: var(--space-200) 0;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:hover {
    color: var(--primary-main);
  }

  summary:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--space-050);
  }

  summary :global(.caret) {
    flex: none;
    transition: transform var(--duration-fast) ease-out;
  }

  .breadcrumbs[open] summary :global(.caret) {
    transform: rotate(90deg);
  }

  p {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  fieldset {
    border: 0;
    display: grid;
    gap: var(--space-200) var(--space-400);
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    margin: 0;
    padding: 0;
  }

  label {
    align-items: center;
    cursor: pointer;
    display: flex;
    gap: var(--space-200);
    min-height: var(--control-height-300);
  }

  input {
    accent-color: var(--primary-main);
    block-size: 1.125rem;
    inline-size: 1.125rem;
    margin: 0;
  }
</style>
