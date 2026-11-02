<script lang="ts">
  import LockSimpleIcon from 'phosphor-svelte/lib/LockSimpleIcon';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import type { Snippet } from 'svelte';

  interface Props {
    active: boolean;
    reachable?: boolean;
    before?: boolean;
    after?: boolean;
    entering?: boolean;
    removing?: boolean;
    unavailableLabel?: string;
    onActivate: () => void;
    onMotionComplete?: () => void;
    children: Snippet;
  }

  let {
    active,
    reachable = true,
    before = false,
    after = false,
    entering = false,
    removing = false,
    unavailableLabel,
    onActivate,
    onMotionComplete,
    children,
  }: Props = $props();
</script>

<div
  class={[
    'auth-card',
    {
      active,
      muted: !active,
      unavailable: !active && !reachable,
      before,
      after,
      entering,
      removing,
    },
  ]}
  onanimationend={(event) => {
    if (event.currentTarget === event.target) onMotionComplete?.();
  }}
  ontransitionend={(event) => {
    if (event.currentTarget === event.target && event.propertyName === 'opacity') {
      onMotionComplete?.();
    }
  }}
>
  {#if !active && reachable}
    <div class="stage-activation" onclick={onActivate} aria-hidden="true"></div>
  {/if}
  {#if !active && !reachable && unavailableLabel}
    <Tooltip label={unavailableLabel}>
      {#snippet trigger({ props })}
        <span {...props} class="unavailable-cue" tabindex="-1" aria-hidden="true">
          <LockSimpleIcon aria-hidden="true" />
        </span>
      {/snippet}
    </Tooltip>
  {/if}
  <div class="card-content" inert={!active} aria-hidden={!active}>
    {@render children()}
  </div>
</div>

<style>
  .auth-card {
    position: relative;
  }

  .card-content {
    position: relative;
    z-index: 1;
  }

  .stage-activation {
    background: transparent;
    border: 0;
    cursor: pointer;
    inset: 0;
    position: absolute;
    z-index: 2;
  }

  .auth-card.muted.unavailable {
    cursor: default;
  }

  .auth-card.muted {
    cursor: pointer;
  }

  .auth-card.muted .card-content {
    pointer-events: none;
  }

  .unavailable-cue {
    background: var(--surface-container);
    border-radius: var(--radii-round);
    inset-block-start: var(--space-200);
    inset-inline-end: var(--space-200);
    padding: var(--space-100);
    position: absolute;
    z-index: 3;
  }

  .unavailable-cue :global(svg) {
    display: block;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }
</style>
