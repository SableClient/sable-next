<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import UnreadBadge from '#lib/ui/primitives/UnreadBadge.svelte';
  import { useAlertProviders, type Priority, type PriorityProvider } from './alerts.js';
  import { fly } from 'svelte/transition';
  import { backOut } from 'svelte/easing';
  import { MOTION_MS, motionMs } from '#lib/ui/motion.js';
  import { alertListState } from './AlertList.svelte';

  // lowest to highest
  const PRIORITY_HIERARCHY = [null, 'update', 'warning', 'task', 'security', 'critical'];

  type Mode = 'mobile' | 'compact' | 'desktop';

  interface Props {
    mode: Mode;
  }

  let { mode }: Props = $props();

  const alertProviders = useAlertProviders();

  let mainPriority = $derived(
    alertProviders.reduce((mainPriority, provider) => {
      if (
        PRIORITY_HIERARCHY.indexOf(provider.priority?.level ?? null) >
        PRIORITY_HIERARCHY.indexOf(mainPriority?.level ?? null)
      ) {
        return provider.priority;
      } else {
        return mainPriority;
      }
    }, null as Priority)
  );

  let mainProgress = $derived(
    alertProviders
      .filter((provider) => provider.progress !== undefined)
      .reduce(
        (mainProvider, provider) => {
          if (
            PRIORITY_HIERARCHY.indexOf(provider.priority?.level ?? null) >
            PRIORITY_HIERARCHY.indexOf(mainProvider.priority?.level ?? null)
          ) {
            return provider;
          } else {
            return mainProvider;
          }
        },
        { priority: null, progress: undefined } as PriorityProvider
      ).progress
  );

  let classes = $derived([
    'quick-tool alert-tool account-tool',
    `priority-${mainPriority?.level}`,
    { 'has-progress': mainProgress !== undefined },
    { indeterminate: mainProgress && mainProgress.value === null ? true : undefined },
  ]);

  let pendingAlerts = $derived(
    alertProviders.filter((provider) => provider.priority !== null).length
  );
</script>

{#if mainPriority !== null}
  {const Icon = $derived(mainPriority.icon)}
  {#if mode === 'mobile'}
    <button
      type="button"
      class={[...classes, 'mobile-tool', 'progress']}
      aria-label={i18n.t('nav.alerts')}
      style:--progress={mainProgress?.value ?? 0}
      draggable="false"
      onclick={() => {
        alertListState.open = true;
      }}
    >
      <svg class="progress" viewBox="0 0 100 100">
        <circle class="progress-circle" cx="50" cy="50" r="50" />
      </svg>
      <span class="mobile-icon"><Icon /></span>
      {#if pendingAlerts > 1}
        <UnreadBadge
          class="priority-{mainPriority.level}"
          counts={{ unread: 0, highlight: pendingAlerts }}
          aria-hidden="true"
        />
      {/if}
    </button>
  {:else}
    <Tooltip label={i18n.t('nav.alerts')} side={mode === 'compact' ? 'right' : 'top'} align="center"
      >``
      {#snippet trigger({ props: tooltipProps }: { props: Record<string, unknown> })}
        <button
          {...tooltipProps}
          type="button"
          class={[
            ...classes,
            'desktop-tool nav-tab nav-tab-outlined',
            mode === 'compact' ? 'compact-tool nav-tab-side' : 'desktop-tool nav-tab-bottom',
          ]}
          aria-label={i18n.t('nav.alerts')}
          data-current={alertListState.open}
          onclick={() => {
            alertListState.open = !alertListState.open;
          }}
          style:--progress={mainProgress?.value ?? 0}
          transition:fly|global={{ duration: motionMs(MOTION_MS.fast), easing: backOut, y: 50 }}
        >
          <span class="nav-tab-hit-area" aria-hidden="true"></span>
          <span class="progress"></span>
          <span class="progress indeterminate"></span>
          <Icon weight={alertListState.open ? 'fill' : 'regular'} />
          {#if pendingAlerts > 1}
            <UnreadBadge counts={{ unread: 0, highlight: pendingAlerts }} aria-hidden="true" />
          {/if}
        </button>
      {/snippet}
    </Tooltip>
  {/if}
{/if}

<style>
  .quick-tool {
    border-color: var(--alert-main-color);
    color: var(--alert-main-color);
    position: relative;

    --alert-main-color: var(--surface-on-container);

    :global(.unread-badge) {
      background-color: var(--alert-main-color);
    }
  }

  .quick-tool[data-current='true'] {
    background-color: var(--surface-container-active);
    color: var(--alert-main-color);
  }

  .quick-tool[data-current='true']:hover {
    background-color: var(--surface-container-hover);
  }

  .priority-critical {
    --alert-main-color: var(--crit-main);

    background-color: var(--crit-container);
  }

  .priority-warning,
  .priority-security {
    --alert-main-color: var(--warn-main);
  }

  .priority-security {
    background-color: var(--warn-container);
  }

  .priority-update {
    --alert-main-color: var(--success-main);
  }

  .priority-task {
    --alert-main-color: var(--primary-main);

    border-color: var(--bg-container-line);
  }

  .desktop-tool {
    .progress {
      border-radius: calc(var(--radius) - 1px);
      height: 100%;
      left: 0;
      overflow: clip;
      position: absolute;
      top: 0;
      transform-origin: left center;
      width: 100%;
      z-index: -1;
    }

    .progress::after {
      background-color: var(--alert-main-color);
      bottom: 0;
      content: '';
      height: 0%;
      left: 0;
      position: absolute;
    }

    .progress:not(.indeterminate)::after {
      width: calc(var(--progress) * 100%);
    }

    .progress.indeterminate::after {
      display: none;
      height: 10%;
      width: 100%;
    }

    &.has-progress:not(.indeterminate) .progress:not(.indeterminate)::after {
      height: 10%;
    }

    &.has-progress.indeterminate .progress.indeterminate::after {
      display: block;
    }
  }

  .mobile-tool {
    &.priority-update {
      background-color: var(--success-container);
    }

    &.priority-task {
      background-color: var(--bg-container);
    }
  }

  .mobile-tool .progress {
    height: 100%;
    inset: 0;
    overflow: visible;
    position: absolute;
    transform: rotate(-90deg);
    width: 100%;

    .progress-circle {
      fill: transparent;
      stroke: var(--alert-main-color);
      stroke-dasharray: var(--circumference);
      stroke-dashoffset: calc(var(--circumference) - (var(--circumference) * var(--progress)));
      stroke-width: 0;
      transform-origin: center center;

      /* 2 * pi * 50 (radius of the circle) */
      --circumference: 314.1593px;
    }

    .desktop-tool:not(.has-progress) .progress {
      height: 0%;
    }
  }

  .mobile-tool.has-progress .progress-circle {
    stroke-width: 3px;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.desktop-tool .progress::after) {
      transition:
        width var(--motion-normal) var(--ease-smooth-out),
        height var(--motion-normal) var(--ease-smooth-out);
    }

    :global(.mobile-tool .progress-circle) {
      transition: stroke-dashoffset var(--motion-normal) var(--ease-smooth-out);
    }

    :global(html:not([data-reduced-motion='on']) .desktop-tool .progress.indeterminate::after) {
      animation: progress-linear-indeterminate 1.4s var(--motion-easing-standard) infinite;
    }

    :global(html:not([data-reduced-motion='on']) .mobile-tool.indeterminate .progress) {
      animation: progress-circle-indeterminate 1.2s var(--motion-easing-spinner) infinite;

      .progress-circle {
        stroke-dashoffset: calc(var(--circumference) * 0.8);
      }
    }
  }

  @keyframes progress-linear-indeterminate {
    from {
      translate: -100% 0;
    }

    to {
      translate: 150% 0;
    }
  }

  @keyframes progress-circle-indeterminate {
    from {
      rotate: 0deg;
    }

    to {
      rotate: 360deg;
    }
  }

  :global(.alert-popover) {
    padding: 0;

    &.social-distancing {
      margin-left: var(--space-200);
    }
  }
</style>
