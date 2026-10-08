<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import SableBrandMark from '#lib/ui/SableBrandMark.svelte';
  import { ALERT_MODULES, useAlertProviders } from './alerts.js';

  const alertProviders = useAlertProviders();
</script>

<div class="alert-list">
  <div class="header">
    <SableBrandMark class="alert-brand" />
    <h3>{$i18n.t('nav.alerts')}</h3>
  </div>
  <div class="banners">
    {#each ALERT_MODULES as module, index (module.default)}
      {#if alertProviders[index].priority !== null}
        <module.default {...alertProviders[index]} />
      {/if}
    {/each}
  </div>
</div>

<style>
  .alert-list {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .header {
    align-items: center;
    background: linear-gradient(to right, var(--primary-container), var(--sec-container) 70%);
    border-bottom: var(--border-width) solid var(--surface-container-line);
    display: flex;
    padding: var(--space-200);

    h3 {
      margin: 0;
      margin-left: var(--space-200);
    }

    :global(.alert-brand) {
      height: 2rem;
      width: 2rem;
    }
  }

  .banners {
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    padding: var(--space-200);
  }
</style>
