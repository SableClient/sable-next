<script lang="ts" module>
  type Stage =
    | { name: 'available' }
    | { name: 'downloading'; percent: number }
    | { name: 'staged' }
    | { name: 'failed'; message: string };

  export function priorityProvider() {
    const POLL_INTERVAL_MS = 300_000;

    let update = $state<AvailableUpdate | null>(null);
    let stage = $state<Stage>({ name: 'available' });
    let visible = $state(true);

    function showUpdate(found: AvailableUpdate): void {
      if (found.version !== update?.version) {
        stage = { name: 'available' };
        visible = true;
      }
      update = found;
    }

    async function poll(): Promise<void> {
      if (stage.name === 'downloading' || stage.name === 'staged') return;
      try {
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

    return {
      get priority(): Priority {
        if (update !== null && visible) {
          return 'update';
        } else {
          return null;
        }
      },

      dismiss() {
        visible = false;
      },

      get update() {
        return update;
      },

      get stage() {
        return stage;
      },

      install,
    };
  }
</script>

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import ArrowCircleUpIcon from 'phosphor-svelte/lib/ArrowCircleUpIcon';

  import { i18n } from '#lib/i18n.js';
  import {
    checkForUpdate,
    relaunchApp,
    supportsAutoUpdate,
    subscribeToUpdates,
    type AvailableUpdate,
  } from '#lib/platform/updates.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import Banner from '#lib/ui/primitives/Banner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Progress from '#lib/ui/primitives/Progress.svelte';
  import type { Priority, PriorityProvider } from '#lib/features/sidebar/alerts.js';

  type UpdateState = { update: AvailableUpdate | null; stage: Stage; install(): Promise<void> };

  let { dismiss, update, stage, install }: PriorityProvider<UpdateState> = $props();

  const bannerTitle = $derived(
    stage.name === 'staged'
      ? $i18n.t('settings.updateBannerStagedTitle')
      : stage.name === 'failed'
        ? $i18n.t('settings.updateBannerFailedTitle')
        : $i18n.t('settings.updateBannerTitle')
  );

  const version = $derived(update?.version ?? '');
</script>

<Banner icon={ArrowCircleUpIcon}>
  {#snippet title()}
    {bannerTitle}
  {/snippet}
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
    <Button variant="ghost" size="small" onclick={dismiss}>
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
        {stage.name === 'failed' ? $i18n.t('common.retry') : $i18n.t('common.install')}
      </Button>
    {/if}
  {/snippet}
</Banner>
