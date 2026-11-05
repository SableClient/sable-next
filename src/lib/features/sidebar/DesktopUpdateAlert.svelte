<script lang="ts" module>
  export function priorityProvider() {
    const POLL_INTERVAL_MS = 300_000;

    let visible = $state(true);
    let packagedVersion = $state<string | null>(null);

    function showUpdate(found: AvailableUpdate): void {
      if (found.version !== desktopUpdate.update?.version) visible = true;
      setPendingUpdate(found);
    }

    async function poll(): Promise<void> {
      const { stage } = desktopUpdate;
      if (stage.name === 'downloading' || stage.name === 'staged') return;
      try {
        if (!supportsAutoUpdate()) {
          const found = await checkForPackagedUpdate();
          if (found !== packagedVersion) visible = true;
          packagedVersion = found;
          return;
        }
        const found = await checkForUpdate();
        if (found) showUpdate(found);
      } catch (error) {
        console.debug('[sable updates] check failed', error);
      }
    }

    onMount(() =>
      subscribeToUpdates((found) => {
        showUpdate(found);
      })
    );

    $effect(() => {
      if (!supportsDesktopUpdateChecks() || !preferences.autoUpdateCheck) return undefined;

      untrack(() => void poll());
      const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
      return () => {
        clearInterval(timer);
      };
    });

    return {
      get priority(): Priority {
        if ((desktopUpdate.update !== null || packagedVersion !== null) && visible) {
          return 'update';
        } else {
          return null;
        }
      },

      dismiss() {
        visible = false;
      },

      get update() {
        return desktopUpdate.update;
      },

      get stage() {
        return desktopUpdate.stage;
      },

      get packagedVersion() {
        return packagedVersion;
      },

      install: installPendingUpdate,
    };
  }
</script>

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import ArrowCircleUpIcon from 'phosphor-svelte/lib/ArrowCircleUpIcon';

  import { i18n } from '#lib/i18n.js';
  import {
    desktopUpdate,
    installPendingUpdate,
    setPendingUpdate,
    type UpdateStage,
  } from '#lib/platform/desktop-update.svelte.js';
  import {
    checkForPackagedUpdate,
    checkForUpdate,
    relaunchApp,
    supportsAutoUpdate,
    supportsDesktopUpdateChecks,
    subscribeToUpdates,
    type AvailableUpdate,
  } from '#lib/platform/updates.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import AlertBanner from '#lib/ui/primitives/AlertBanner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Progress from '#lib/ui/primitives/Progress.svelte';
  import type { Priority, PriorityProvider } from '#lib/features/sidebar/alerts.js';

  type UpdateState = {
    update: AvailableUpdate | null;
    packagedVersion: string | null;
    stage: UpdateStage;
    install(): Promise<void>;
  };

  let { dismiss, update, packagedVersion, stage, install }: PriorityProvider<UpdateState> =
    $props();

  const bannerTitle = $derived(
    stage.name === 'staged'
      ? i18n.t('settings.updateBannerStagedTitle')
      : stage.name === 'failed'
        ? i18n.t('settings.updateBannerFailedTitle')
        : i18n.t('settings.updateBannerTitle')
  );

  const version = $derived(update?.version ?? '');
</script>

<AlertBanner icon={ArrowCircleUpIcon}>
  {#snippet title()}
    {bannerTitle}
  {/snippet}
  {#snippet body()}
    {#if packagedVersion}
      {i18n.t('settings.aboutPackageUpdateAvailable')}
    {:else if stage.name === 'staged'}
      {i18n.t('settings.updateBannerStagedBody', { version })}
    {:else if stage.name === 'failed'}
      {stage.message}
    {:else if stage.name === 'downloading'}
      {@const label = i18n.t('settings.updateBannerProgress', { percent: stage.percent })}
      <Progress value={stage.percent} {label} />
      {label}
    {:else}
      {i18n.t('settings.updateBannerBody', { version })}
    {/if}
  {/snippet}
  {#snippet actions()}
    <Button variant="ghost" size="small" onclick={dismiss}>
      {i18n.t('settings.updateBannerLater')}
    </Button>
    {#if !packagedVersion && stage.name === 'staged'}
      <Button variant="primary" size="small" onclick={() => void relaunchApp()}>
        {i18n.t('settings.updateBannerRestart')}
      </Button>
    {:else if !packagedVersion}
      <Button
        variant="primary"
        size="small"
        loading={stage.name === 'downloading'}
        onclick={() => void install()}
      >
        {stage.name === 'failed' ? i18n.t('common.retry') : i18n.t('common.install')}
      </Button>
    {/if}
  {/snippet}
</AlertBanner>
