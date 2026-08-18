<script lang="ts">
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';

  type DialogVariant = 'drawer' | 'settings' | 'verification' | 'sheet';

  interface Props {
    open?: boolean;
    variant: DialogVariant;
    label?: string;
    contentStyle?: string;
    onOpenChange?: (open: boolean) => void;
    children: Snippet;
  }

  let {
    open = $bindable(),
    variant,
    label,
    contentStyle,
    onOpenChange,
    children,
  }: Props = $props();
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class={['sable-dialog-backdrop', `sable-dialog-backdrop-${variant}`]} />
    <Dialog.Content
      class={['sable-dialog-content', `sable-dialog-content-${variant}`]}
      style={contentStyle}
      aria-label={label}
    >
      {@render children()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.sable-dialog-backdrop) {
    background: var(--sable-overlay);
    inset: 0;
    position: fixed;
  }

  :global(.sable-dialog-content) {
    box-sizing: border-box;
    position: fixed;
  }

  :global(.sable-dialog-backdrop-drawer) {
    border: 0;
    z-index: var(--layer-dialog);
  }

  :global(.sable-dialog-content-drawer) {
    border: 0;
    inset: 0 0 0 auto;
    max-width: min(22rem, 85%);
    padding: 0;
    width: 100%;
    z-index: var(--layer-dialog);
  }

  :global(.sable-dialog-backdrop-verification),
  :global(.sable-dialog-backdrop-sheet) {
    z-index: var(--layer-sheet);
  }

  :global(.sable-dialog-backdrop-settings) {
    z-index: var(--layer-dialog);
  }

  :global(.sable-dialog-content-settings) {
    background: var(--sable-surface-container);
    border: 0;
    border-radius: 0;
    box-shadow: var(--shadow-dialog);
    height: 100dvh;
    left: 50%;
    max-width: 68rem;
    overflow: hidden;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 100%;
    z-index: var(--layer-dialog);
  }

  :global(.sable-dialog-content-verification),
  :global(.sable-dialog-content-sheet) {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius) var(--radius) 0 0;
    bottom: 0;
    box-shadow: var(--shadow-dialog);
    max-height: calc(100dvh - var(--space-2) * 2);
    overflow: auto;
    padding: var(--space-4);

    /* Bottom-anchored, so the home indicator would otherwise sit on the content. */
    padding-bottom: calc(var(--space-4) + var(--safe-bottom));
    width: 100%;
    z-index: var(--layer-sheet);
  }

  :global(.sable-dialog-content-sheet) {
    overscroll-behavior: contain;
    padding: 0 0 var(--safe-bottom);
  }

  @media (width >= 42rem) {
    :global(.sable-dialog-content-verification) {
      border-radius: var(--radius);
      bottom: auto;
      left: 50%;
      max-width: 34rem;
      padding: calc(var(--space-2) * 2);
      top: 50%;
      transform: translate(-50%, -50%);
    }
  }

  @media (width >= 48rem) {
    :global(.sable-dialog-content-settings) {
      border: 1px solid var(--sable-surface-container-line);
      border-radius: var(--radius-card);
      height: min(52rem, calc(100dvh - 3rem));
      width: calc(100% - 3rem);
    }
  }

  @keyframes dialog-backdrop-in {
    from {
      opacity: 0;
    }
  }

  @keyframes dialog-in {
    from {
      opacity: 0;
      transform: translate(-50%, calc(-50% + var(--space-1))) scale(0.98);
    }
  }

  @keyframes sheet-in {
    from {
      opacity: 0;
      transform: translateY(var(--space-2));
    }
  }

  @keyframes drawer-in {
    from {
      transform: translateX(var(--space-3));
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.sable-dialog-backdrop) {
      animation: dialog-backdrop-in var(--motion-normal) var(--motion-easing-standard);
    }

    :global(.sable-dialog-content-drawer) {
      animation: drawer-in var(--motion-slow) var(--motion-easing-emphasized);
    }

    :global(.sable-dialog-content-settings),
    :global(.sable-dialog-content-verification),
    :global(.sable-dialog-content-sheet) {
      animation: sheet-in var(--motion-slow) var(--motion-easing-emphasized);
    }
  }

  @media (prefers-reduced-motion: no-preference) and (width >= 48rem) {
    :global(.sable-dialog-content-settings) {
      animation: dialog-in var(--motion-slow) var(--motion-easing-emphasized);
    }
  }
</style>
