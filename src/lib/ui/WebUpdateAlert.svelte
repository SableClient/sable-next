<script lang="ts" module>
  export function priorityProvider() {
    const POLL_INTERVAL_MS = 300_000;

    let visible = $state(false);

    $effect(() => {
      if (!preferences.autoUpdateCheck || !('serviceWorker' in navigator)) return undefined;

      const check = (): void => {
        checkForWebUpdate().catch((error: unknown) => {
          console.debug('[sable updates] web update check failed', error);
        });
      };
      check();
      const timer = setInterval(check, POLL_INTERVAL_MS);

      return () => clearInterval(timer);
    });

    $effect(() => {
      if (webUpdateState.generation > 0) visible = true;
    });

    return {
      get priority(): Priority {
        if (visible) {
          return 'update';
        } else {
          return null;
        }
      },

      dismiss() {
        visible = false;
      },
    };
  }
</script>

<script lang="ts">
  import { on } from 'svelte/events';
  import { i18n } from '#lib/i18n.js';
  import { checkForWebUpdate, webUpdateState } from '#lib/platform/web-updates.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import Banner from '#lib/ui/primitives/Banner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import type { Priority, PriorityProvider } from '#lib/features/sidebar/alerts.js';
  import ArrowCircleUpIcon from 'phosphor-svelte/lib/ArrowCircleUpIcon';

  const registration = $derived(webUpdateState.registration);

  let { dismiss }: PriorityProvider = $props();

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
</script>

<Banner icon={ArrowCircleUpIcon}>
  {#snippet title()}
    {$i18n.t('settings.updateBannerTitle')}
  {/snippet}
  {#snippet body()}
    {$i18n.t('settings.webUpdateAlertBody')}
  {/snippet}
  {#snippet actions()}
    <Button variant="ghost" size="small" onclick={() => dismiss()}>
      {$i18n.t('settings.updateBannerLater')}
    </Button>
    <Button variant="primary" size="small" onclick={refresh}>
      {$i18n.t('common.install')}
    </Button>
  {/snippet}
</Banner>
