<script lang="ts">
  import { onMount } from 'svelte';
  import { on } from 'svelte/events';
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon';

  import { i18n } from '#lib/i18n.js';
  import { checkForWebUpdate, webUpdateState } from '#lib/platform/web-updates.svelte.js';
  import Banner from '#lib/ui/primitives/Banner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';

  const registration = $derived(webUpdateState.registration);
  let dismissed = $state(false);

  const POLL_INTERVAL_MS = 300_000;

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

    const check = (): void => {
      checkForWebUpdate().catch((error: unknown) => {
        console.debug('[sable updates] web update check failed', error);
      });
    };
    check();
    const timer = setInterval(check, POLL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  });

  $effect(() => {
    if (webUpdateState.generation > 0) dismissed = false;
  });
</script>

{#if registration && !dismissed}
  <Banner icon={ArrowClockwiseIcon} onClose={() => (dismissed = true)}>
    {#snippet title()}
      {$i18n.t('settings.webUpdateBannerTitle')}
    {/snippet}
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
