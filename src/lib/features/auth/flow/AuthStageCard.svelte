<script lang="ts">
  import LockSimpleIcon from 'phosphor-svelte/lib/LockSimpleIcon';
  import type { Snippet } from 'svelte';

  interface Props {
    active: boolean;
    reachable?: boolean;
    before?: boolean;
    after?: boolean;
    entering?: boolean;
    removing?: boolean;
    accessibilityLabel: string;
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
    accessibilityLabel,
    unavailableLabel,
    onActivate,
    onMotionComplete,
    children,
  }: Props = $props();
</script>

<div
  class="auth-card"
  class:active
  class:muted={!active}
  class:unavailable={!active && !reachable}
  class:before
  class:after
  class:entering
  class:removing
  onanimationend={(event) => {
    if (event.currentTarget === event.target) onMotionComplete?.();
  }}
  ontransitionend={(event) => {
    if (event.currentTarget === event.target && event.propertyName === 'opacity') {
      onMotionComplete?.();
    }
  }}
>
  <button
    class="stage-activation"
    class:active
    type="button"
    onclick={onActivate}
    aria-label={accessibilityLabel}
    aria-hidden={active}
    disabled={!reachable}
    tabindex={active || !reachable ? -1 : 0}
  ></button>
  {#if !active && !reachable && unavailableLabel}
    <span class="unavailable-cue" role="img" title={unavailableLabel} aria-label={unavailableLabel}>
      <LockSimpleIcon aria-hidden="true" />
    </span>
  {/if}
  <div class="card-content" inert={!active}>
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

  .stage-activation.active {
    opacity: 0;
    pointer-events: none;
  }

  .stage-activation:disabled,
  .auth-card.muted.unavailable {
    cursor: default;
  }

  .stage-activation:focus-visible {
    border-radius: var(--radius);
    box-shadow: 0 0 0 var(--focus-ring-width) var(--focus-ring);
    outline: none;
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
