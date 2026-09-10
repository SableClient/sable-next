<script lang="ts">
  import { version } from '$app/env';
  import { onMount } from 'svelte';
  import { on } from 'svelte/events';
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon';

  import { i18n } from '#lib/i18n.js';
  import Banner from '#lib/ui/primitives/Banner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';

  let registration = $state<ServiceWorkerRegistration | null>(null);
  let dismissed = $state(false);
  let live = true;

  const VERSION_REPLY_MS = 1_500;

  function workerVersion(worker: ServiceWorker): Promise<string | null> {
    return new Promise((settle) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => settle(null), VERSION_REPLY_MS);
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        clearTimeout(timer);
        settle(typeof event.data === 'string' ? event.data : null);
      };
      worker.postMessage({ type: 'sable:version' }, [channel.port2]);
    });
  }

  async function consider(next: ServiceWorkerRegistration, worker: ServiceWorker): Promise<void> {
    const reported = await workerVersion(worker);
    if (!live) return;
    if (reported === version) {
      worker.postMessage({ type: 'sable:skip-waiting' });
      return;
    }
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

    let stopInstalling: (() => void) | undefined;
    let stopUpdates: (() => void) | undefined;
    void navigator.serviceWorker.ready
      .then((ready) => {
        if (!live) return;
        if (ready.waiting) void consider(ready, ready.waiting);

        const onUpdate = (): void => {
          if (!live) return;
          const installing = ready.installing;
          if (installing === null) return;

          const onStateChange = (): void => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              void consider(ready, installing);
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
      live = false;
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
