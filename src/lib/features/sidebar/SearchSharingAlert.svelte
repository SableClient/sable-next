<script lang="ts" module>
  import CloudArrowDownIcon from 'phosphor-svelte/lib/CloudArrowDownIcon';
  import CloudArrowUpIcon from 'phosphor-svelte/lib/CloudArrowUpIcon';
  import CloudCheckIcon from 'phosphor-svelte/lib/CloudCheckIcon';
  import CloudXIcon from 'phosphor-svelte/lib/CloudXIcon';
  import type { AlertProgress, Priority, PriorityProvider } from './alerts';
  import AlertBanner from '#lib/ui/primitives/AlertBanner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Progress from '#lib/ui/primitives/Progress.svelte';
  import type { SearchSharingView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.ts';
  import { i18n } from '#lib/i18n.ts';

  export function priorityProvider() {
    const core = useCoreClient();

    let sharing = $state<SearchSharingView | null>(null);
    let dismissed = $state(false);

    $effect(() => {
      return core.subscribeEvents((event) => {
        if (event.type === 'search_sharing') {
          sharing = event.sharing;
          if (
            sharing.state === 'discovering' ||
            sharing.state === 'connecting' ||
            sharing.state === 'receiving'
          ) {
            dismissed = false;
          } else if (sharing.state === 'off') {
            dismissed = true;
          }
        }
      });
    });

    return {
      get priority(): Priority {
        if (sharing === null) {
          return null;
        } else if (
          sharing.state === 'connecting' ||
          sharing.state === 'waiting' ||
          sharing.state === 'receiving'
        ) {
          return {
            icon: CloudArrowDownIcon,
            level: 'task',
          };
        } else if (sharing.state === 'sending') {
          return {
            icon: CloudArrowUpIcon,
            level: 'task',
          };
        } else if (sharing.state === 'idle' && !dismissed && sharing.candidates.length > 0) {
          if (sharing.outcome === 'failed') {
            return {
              icon: CloudXIcon,
              level: 'warning',
            };
          } else if (sharing.outcome === 'completed') {
            return {
              icon: CloudCheckIcon,
              level: 'task',
            };
          } else {
            return null;
          }
        } else {
          return null;
        }
      },

      get progress(): AlertProgress | undefined {
        if (sharing === null) {
          return undefined;
        } else if (sharing.state === 'connecting') {
          return { value: null };
        } else if (sharing.state === 'receiving') {
          return {
            value: sharing.total_rooms > 0 ? sharing.transferred_rooms / sharing.total_rooms : null,
          };
        } else {
          return undefined;
        }
      },

      get sharing() {
        return sharing;
      },

      dismiss() {
        dismissed = true;
      },

      retry() {
        core.rpc.search.peerFind({}).catch(() => {});
      },
    };
  }
</script>

<script lang="ts">
  type SharingState = {
    priority: Exclude<Priority, null>;
    progress: AlertProgress | undefined;
    sharing: SearchSharingView;
    dismiss(): void;
    retry(): void;
  };

  let { priority, progress, sharing, dismiss, retry }: PriorityProvider<SharingState> = $props();

  const named = $derived(sharing.state === 'idle' ? sharing.last_copy : sharing.peer);
  const device = $derived(
    named?.name ?? named?.device_id ?? i18n.t('settings.searchTransferAlert.anotherDevice')
  );
</script>

<AlertBanner icon={priority.icon} tone={priority.level === 'warning' ? 'warning' : 'neutral'}>
  {#snippet title()}
    {#if sharing.state === 'idle' && sharing.outcome === 'failed'}
      {i18n.t('settings.searchTransferAlert.title.failed')}
    {:else if sharing.state === 'idle'}
      {i18n.t('settings.searchTransferAlert.title.complete')}
    {:else}
      {i18n.t('settings.searchTransferAlert.title.busy')}
    {/if}
  {/snippet}
  {#snippet body()}
    <div class="explainer">
      {i18n.t('settings.searchTransferAlert.explainer')}
    </div>
    {#if progress !== undefined}
      <div class="progress">
        <Progress
          label={i18n.t('settings.searchTransferAlert.transferProgress')}
          value={progress.value === null ? null : progress.value * 100}
        />
      </div>
    {/if}
    <div class="transfer-status" aria-live={sharing.state === 'receiving' ? 'off' : undefined}>
      {#if sharing.state === 'sending'}
        {i18n.t('settings.searchTransferAlert.body.sending', { device })}
      {:else if sharing.state === 'receiving'}
        {i18n.t('settings.searchTransferAlert.body.receiving', {
          transferred: sharing.transferred_rooms,
          total: sharing.total_rooms,
          device,
        })}
      {:else if sharing.state === 'connecting'}
        {i18n.t('settings.searchTransferAlert.body.connecting', { device })}
      {:else if sharing.state === 'waiting'}
        {i18n.t('settings.searchTransferAlert.body.waiting', { device })}
      {:else if sharing.state === 'idle' && sharing.outcome === 'failed'}
        {i18n.t('settings.searchTransferAlert.body.failed')}
      {:else if sharing.state === 'idle'}
        {i18n.t('settings.searchTransferAlert.body.complete', {
          count: sharing.transferred_rooms,
          device,
        })}
      {/if}
    </div>
  {/snippet}
  {#snippet actions()}
    {#if sharing.state === 'idle'}
      <Button variant="ghost" size="small" onclick={dismiss}>
        {i18n.t('common.dismiss')}
      </Button>
    {/if}
    {#if sharing.state === 'idle' && sharing.outcome === 'failed'}
      <Button variant="secondary" size="small" onclick={retry}>
        {i18n.t('common.retry')}
      </Button>
    {/if}
  {/snippet}
</AlertBanner>

<style>
  .explainer {
    border-bottom: var(--border-width) solid var(--surface-var-container-line);
    padding-bottom: var(--space-200);
  }

  .progress {
    padding-top: var(--space-200);
  }

  .transfer-status {
    color: var(--surface-var-on-container);
    font-variant: tabular-nums;
    padding-top: var(--space-200);
  }
</style>
