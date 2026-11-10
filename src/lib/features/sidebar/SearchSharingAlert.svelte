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
          sharing.state === 'discovering' ||
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
        } else if (sharing.state === 'idle' && !dismissed) {
          if (sharing.outcome === 'failed') {
            return {
              icon: CloudXIcon,
              level: 'warning',
            };
          } else if (sharing.outcome === 'completed' || sharing.outcome === 'nothing_to_copy') {
            return {
              icon: CloudCheckIcon,
              level: 'task',
            };
          } else if (sharing.outcome === 'no_answer') {
            return {
              icon: CloudArrowDownIcon,
              level: 'warning',
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
        } else if (sharing.state === 'discovering' || sharing.state === 'connecting') {
          return { value: null };
        } else if (sharing.state === 'receiving') {
          return { value: sharing.transferred_rooms / sharing.total_rooms };
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
</script>

<AlertBanner icon={priority.icon}>
  {#snippet title()}
    {#if sharing.state === 'idle' && sharing.outcome === 'failed'}
      {i18n.t('settings.searchTransferAlert.title.failed')}
    {:else if sharing.state === 'idle' && sharing.outcome === 'no_answer'}
      {i18n.t('settings.searchTransferAlert.title.no_answer')}
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
          value={progress.value ? progress.value * 100 : null}
        />
      </div>
    {/if}
    <div class="transfer-status">
      {#if sharing.state === 'sending'}
        {i18n.t('settings.searchTransferAlert.body.sending')}
      {:else if sharing.state === 'receiving'}
        {i18n.t('settings.searchTransferAlert.body.receiving', {
          transferred: sharing.transferred_rooms,
          total: sharing.total_rooms,
        })}
      {:else if sharing.state === 'discovering'}
        {i18n.t('settings.searchTransferAlert.body.discovering')}
      {:else if sharing.state === 'connecting'}
        {i18n.t('settings.searchTransferAlert.body.connecting')}
      {:else if sharing.state === 'waiting'}
        {i18n.t('settings.searchTransferAlert.body.waiting')}
      {:else if sharing.state === 'idle' && sharing.outcome === 'failed'}
        {i18n.t('settings.searchTransferAlert.body.failed')}
      {:else if sharing.state === 'idle' && sharing.outcome === 'no_answer'}
        {i18n.t('settings.searchTransferAlert.body.no_answer')}
      {:else if sharing.state === 'idle'}
        {i18n.t('settings.searchTransferAlert.body.complete', {
          transferred: sharing.transferred_rooms,
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
    {#if sharing.state === 'idle' && (sharing.outcome === 'failed' || sharing.outcome === 'no_answer')}
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
