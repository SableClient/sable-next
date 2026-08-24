<script lang="ts">
  import { untrack } from 'svelte';
  import ArrowCircleUpIcon from 'phosphor-svelte/lib/ArrowCircleUpIcon';

  import { i18n } from '#lib/i18n.js';
  import {
    checkForUpdate,
    relaunchApp,
    supportsAutoUpdate,
    type AvailableUpdate,
  } from '#lib/platform/updates.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import Banner from '#lib/ui/primitives/Banner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Progress from '#lib/ui/primitives/Progress.svelte';

  const POLL_INTERVAL_MS = 300_000;

  type Stage =
    | { name: 'available' }
    | { name: 'downloading'; percent: number }
    | { name: 'staged' }
    | { name: 'failed'; message: string };

  let update = $state<AvailableUpdate | null>(null);
  let stage = $state<Stage>({ name: 'available' });
  let dismissed = $state(false);

  const version = $derived(update?.version ?? '');
  const title = $derived(
    stage.name === 'staged'
      ? $i18n.t('settings.updateBannerStagedTitle')
      : stage.name === 'failed'
        ? $i18n.t('settings.updateBannerFailedTitle')
        : $i18n.t('settings.updateBannerTitle')
  );

  async function poll(): Promise<void> {
    if (stage.name === 'downloading' || stage.name === 'staged') return;
    try {
      const found = await checkForUpdate();
      if (found && found.version !== update?.version) {
        stage = { name: 'available' };
        dismissed = false;
      }
      update = found;
    } catch (error) {
      console.debug('[sable updates] check failed', error);
    }
  }

  $effect(() => {
    if (!supportsAutoUpdate() || !preferences.autoUpdateCheck) return undefined;

    untrack(() => void poll());
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  });

  async function install(): Promise<void> {
    if (!update) return;
    stage = { name: 'downloading', percent: 0 };
    try {
      await update.install((percent) => {
        stage = { name: 'downloading', percent };
      });
      stage = { name: 'staged' };
    } catch (error) {
      stage = { name: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
  }
</script>

{#if update && !dismissed}
  <Banner icon={ArrowCircleUpIcon} {title}>
    {#snippet body()}
      {#if stage.name === 'staged'}
        {$i18n.t('settings.updateBannerStagedBody', { version })}
      {:else if stage.name === 'failed'}
        {stage.message}
      {:else if stage.name === 'downloading'}
        {@const label = $i18n.t('settings.updateBannerProgress', { percent: stage.percent })}
        <Progress value={stage.percent} {label} />
        {label}
      {:else}
        {$i18n.t('settings.updateBannerBody', { version })}
      {/if}
    {/snippet}
    {#snippet actions()}
      <Button
        variant="ghost"
        size="small"
        onclick={() => {
          dismissed = true;
        }}
      >
        {$i18n.t('settings.updateBannerLater')}
      </Button>
      {#if stage.name === 'staged'}
        <Button variant="primary" size="small" onclick={() => void relaunchApp()}>
          {$i18n.t('settings.updateBannerRestart')}
        </Button>
      {:else}
        <Button
          variant="primary"
          size="small"
          loading={stage.name === 'downloading'}
          onclick={() => void install()}
        >
          {stage.name === 'failed'
            ? $i18n.t('settings.updateBannerRetry')
            : $i18n.t('settings.updateBannerInstall')}
        </Button>
      {/if}
    {/snippet}
  </Banner>
{/if}
