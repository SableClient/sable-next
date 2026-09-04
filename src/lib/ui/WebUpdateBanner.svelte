<script lang="ts">
  import { onMount } from 'svelte';
  import { on } from 'svelte/events';
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon';

  import { i18n } from '#lib/i18n.js';
  import Banner from '#lib/ui/primitives/Banner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';

  let registration = $state<ServiceWorkerRegistration | null>(null);
  let dismissed = $state(false);

  function showUpdate(next: ServiceWorkerRegistration): void {
    registration = next;
    dismissed = false;
  }

  function refresh(): void {
    const waiting = registration?.waiting;
    if (!waiting) {
      location.reload();
      return;
    }

    on(navigator.serviceWorker, 'controllerchange', () => location.reload(), {
      once: true,
    });
    waiting.postMessage({ type: 'sable:skip-waiting' });
  }

  onMount(() => {
    if (!('serviceWorker' in navigator)) return;

    let active = true;
    let stopInstalling: (() => void) | undefined;
    let stopUpdates: (() => void) | undefined;
    void navigator.serviceWorker.ready
      .then((ready) => {
        if (!active) return;
        if (ready.waiting) showUpdate(ready);

        const onUpdate = (): void => {
          if (!active) return;
          const installing = ready.installing;
          if (installing === null) return;

          const onStateChange = (): void => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdate(ready);
            }
          };
          stopInstalling?.();
          stopInstalling = on(installing, 'statechange', onStateChange);
        };
        stopUpdates = on(ready, 'updatefound', onUpdate);
        void ready.update();
      })
      .catch((error: unknown) => {
        console.debug('[sable updates] web update check failed', error);
      });

    return () => {
      active = false;
      stopInstalling?.();
      stopUpdates?.();
    };
  });
</script>

{#if registration && !dismissed}
  <Banner icon={ArrowClockwiseIcon} title={$i18n.t('settings.webUpdateBannerTitle')}>
    {#snippet body()}
      {$i18n.t('settings.webUpdateBannerBody')}
    {/snippet}
    {#snippet actions()}
      <Button variant="ghost" size="small" onclick={() => (dismissed = true)}>
        {$i18n.t('settings.updateBannerLater')}
      </Button>
      <Button variant="primary" size="small" onclick={refresh}>
        {$i18n.t('settings.webUpdateBannerRefresh')}
      </Button>
    {/snippet}
  </Banner>
{/if}
