<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    active: boolean;
    before?: boolean;
    after?: boolean;
    entering?: boolean;
    removing?: boolean;
    accessibilityLabel: string;
    onActivate: () => void;
    onMotionComplete?: () => void;
    children: Snippet;
  }

  let {
    active,
    before = false,
    after = false,
    entering = false,
    removing = false,
    accessibilityLabel,
    onActivate,
    onMotionComplete,
    children,
  }: Props = $props();
</script>

<div
  class="auth-card"
  class:active
  class:muted={!active}
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
    tabindex={active ? -1 : 0}
  ></button>
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

  .stage-activation:focus-visible {
    border-radius: var(--radius-card);
    box-shadow: 0 0 0 var(--focus-ring-width) var(--sable-focus-ring);
    outline: none;
  }

  .auth-card.muted {
    cursor: pointer;
  }

  .auth-card.muted .card-content {
    pointer-events: none;
  }
</style>
