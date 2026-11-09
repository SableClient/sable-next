<script lang="ts" module>
  export const alertListState = $state({
    open: false,
  });
</script>

<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import EmptyState from '#lib/ui/primitives/EmptyState.svelte';
  import SableBrandMark from '#lib/ui/SableBrandMark.svelte';
  import { ALERT_MODULES, useAlertProviders } from './alerts.js';

  interface Props {
    isDrawer?: boolean;
  }

  let { isDrawer = true }: Props = $props();

  const alertProviders = useAlertProviders();
  const activeAlerts = $derived(
    ALERT_MODULES.map((module, index) => ({ module, provider: alertProviders[index] })).filter(
      ({ provider }) => provider.priority !== null
    )
  );

  let hadAlerts = false;

  $effect(() => {
    const hasAlerts = activeAlerts.length > 0;

    if (hadAlerts && !hasAlerts) {
      alertListState.open = false;
    } else if (hasAlerts) {
      hadAlerts = true;
    }
  });
</script>

<div class="alert-list">
  <div class={['header', { blur: isDrawer }]}>
    <SableBrandMark class="alert-brand" />
    <h3>{i18n.t('nav.alerts')}</h3>
  </div>
  <div class="banners">
    {#each activeAlerts as { module, provider } (module.default)}
      <module.default {...provider} />
    {:else}
      <EmptyState title={i18n.t('nav.noAlerts')} />
    {/each}
  </div>
</div>

<style>
  .alert-list {
    background: transparent;
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .header {
    align-items: center;
    background: linear-gradient(to right, transparent, var(--surface-container) 50%);
    background-color: var(--primary-container);
    border-bottom: var(--border-width) solid var(--surface-container-line);
    border-top-left-radius: var(--radius);
    border-top-right-radius: var(--radius);
    display: flex;
    padding: var(--space-200);

    h3 {
      margin: 0;
      margin-left: var(--space-200);
      z-index: 2;
    }

    :global(.alert-brand) {
      height: 2rem;
      width: 2rem;
    }
  }

  .header.blur {
    backdrop-filter: blur(10px) brightness(1.4);
    background-color: transparent;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .header.blur {
      animation: header-blur-in 250ms linear 250ms;
      animation-fill-mode: backwards;
    }
  }

  @keyframes header-blur-in {
    from {
      background-color: var(--primary-container);
    }

    to {
      background-color: transparent;
    }
  }

  .banners {
    background-color: var(--surface-container);
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    padding: var(--space-300);
  }
</style>
