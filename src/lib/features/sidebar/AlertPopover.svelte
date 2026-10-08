<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import ResponsivePopover from '#lib/ui/primitives/ResponsivePopover.svelte';
  import { mergeProps } from 'bits-ui';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import UnreadBadge from '#lib/ui/primitives/UnreadBadge.svelte';
  import { resolve } from '$app/paths';
  import ArrowCircleUpIcon from 'phosphor-svelte/lib/ArrowCircleUpIcon';
  import ShieldWarningIcon from 'phosphor-svelte/lib/ShieldWarningIcon';
  import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircleIcon';
  import WarningIcon from 'phosphor-svelte/lib/WarningIcon';
  import AlertList from './AlertList.svelte';
  import { useAlertProviders } from './alerts.js';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';

  // lowest to highest
  const PRIORITY_HIERARCHY = [null, 'update', 'warning', 'security'];

  const PRIORITY_ICONS = {
    critical: WarningIcon,
    warning: WarningCircleIcon,
    security: ShieldWarningIcon,
    update: ArrowCircleUpIcon,
  };

  type Mode = 'mobile' | 'compact' | 'desktop';

  interface Props {
    mode: Mode;
    hasAlerts?: boolean;
  }

  let { mode, hasAlerts = $bindable(false) }: Props = $props();

  let popoverOpen = $state(false);
  let isCurrentPage = $derived(page.url.pathname === '/alerts');

  const alertProviders = useAlertProviders();
  let alertPriorities = $derived(alertProviders.map((provider) => provider.priority));

  let mainPriority = $derived(
    alertPriorities.reduce((finalPriority, priority) => {
      if (PRIORITY_HIERARCHY.indexOf(priority) > PRIORITY_HIERARCHY.indexOf(finalPriority)) {
        return priority;
      } else {
        return finalPriority;
      }
    }, null)
  );

  let pendingAlerts = $derived(alertPriorities.filter((priority) => priority !== null).length);

  $effect(() => {
    if (pendingAlerts > 0) {
      hasAlerts = true;
    } else if (hasAlerts && isCurrentPage) {
      void goto(resolve('/(app)/rooms'));
    }
  });
</script>

{#if mainPriority !== null}
  {const Icon = $derived(PRIORITY_ICONS[mainPriority])}
  {#if mode === 'mobile'}
    <a
      class="quick-tool mobile-tool alert-tool account-tool selection-layer priority-{mainPriority} {isCurrentPage
        ? 'current'
        : ''}"
      href={resolve('/(app)/alerts')}
      aria-label={$i18n.t('nav.alerts')}
      aria-current={isCurrentPage ? 'page' : undefined}
      draggable="false"
    >
      <span class="mobile-icon"><Icon /></span>
      {#if pendingAlerts > 1}
        <UnreadBadge
          class="priority-{mainPriority}"
          counts={{ unread: 0, highlight: pendingAlerts }}
          aria-hidden="true"
        />
      {/if}
    </a>
  {:else}
    {#snippet profileTrigger({ props: tooltipProps }: { props: Record<string, unknown> })}
      <ResponsivePopover
        label={$i18n.t('nav.alerts')}
        closeLabel={$i18n.t('common.close')}
        side={mode === 'compact' ? 'right' : 'top'}
        align="center"
        class="sidebar-popover alert-popover menu-surface {mode === 'compact'
          ? ''
          : 'social-distancing'}"
        sideOffset={mode === 'compact' ? 20 : 24}
        bind:open={popoverOpen}
      >
        {#snippet trigger({ props })}
          <button
            {...mergeProps(tooltipProps, props)}
            type="button"
            class="quick-tool priority-{mainPriority} nav-tab nav-tab-outlined selection-layer {mode ===
            'compact'
              ? 'compact-tool nav-tab-side'
              : 'desktop-tool nav-tab-bottom'}"
            aria-label={$i18n.t('nav.alerts')}
          >
            <Icon />
            {#if pendingAlerts > 1}
              <UnreadBadge
                class="priority-{mainPriority}"
                counts={{ unread: 0, highlight: pendingAlerts }}
                aria-hidden="true"
              />
            {/if}
          </button>
        {/snippet}
        <AlertList />
      </ResponsivePopover>
    {/snippet}
    <Tooltip
      label={$i18n.t('nav.alerts')}
      side={mode === 'compact' ? 'right' : 'top'}
      align="center"
      trigger={profileTrigger}
    />
  {/if}
{/if}

<style>
  .priority-critical {
    background-color: var(--crit-container);
    border-color: var(--crit-main);
    color: var(--crit-main);

    :global(.unread-badge) {
      background-color: var(--crit-main);
    }
  }

  .priority-warning,
  .priority-security {
    background-color: var(--warn-container);
    border-color: var(--warn-main);
    color: var(--warn-main);

    :global(.unread-badge) {
      background-color: var(--warn-main);
    }
  }

  .priority-update {
    border-color: var(--success-main);
    color: var(--success-main);
  }

  .mobile-tool {
    &.priority-update {
      background-color: var(--success-container);
    }

    &.current {
      background-color: transparent;
      color: var(--bg-on-container);

      :global(.unread-badge) {
        background-color: var(--success-main);
      }

      &::after {
        opacity: 0;
      }
    }

    transition:
      background-color var(--motion-normal) ease,
      color var(--motion-normal) ease;

    :global(.unread-badge) {
      transition: background-color var(--motion-normal) ease;
    }
  }

  :global(.alert-popover) {
    padding: 0;

    &.social-distancing {
      margin-left: var(--space-200);
    }
  }
</style>
