<script lang="ts">
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';

  import { holdOverlayBack } from '#lib/platform/overlay-back.svelte.js';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';

  type DialogVariant = 'drawer' | 'settings' | 'verification' | 'sheet' | 'fullscreen';

  interface Props {
    open?: boolean;
    variant: DialogVariant;
    ownsBack?: boolean;
    label?: string;
    contentStyle?: string;
    contentClass?: string;
    onOpenChange?: (open: boolean) => void;
    onOpenAutoFocus?: (event: Event) => void;
    onConfirm?: () => void;
    children: Snippet;
  }

  let {
    open = $bindable(),
    variant,
    ownsBack = false,
    label,
    contentStyle,
    contentClass = '',
    onOpenChange,
    onOpenAutoFocus,
    onConfirm,
    children,
  }: Props = $props();

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    onConfirm?.();
  }

  holdOverlayBack(
    () => open === true && !ownsBack,
    () => {
      open = false;
      onOpenChange?.(false);
    }
  );
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class={['dialog-backdrop', `dialog-backdrop-${variant}`]} {...overlayLayer()} />
    <Dialog.Content
      class={['dialog-content', `dialog-content-${variant}`, contentClass]}
      {...overlayLayer()}
      style={contentStyle}
      aria-label={label}
      {onOpenAutoFocus}
    >
      {#if onConfirm}
        <form class="dialog-form" onsubmit={submit}>{@render children()}</form>
      {:else}
        {@render children()}
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  .dialog-form {
    display: contents;
  }

  :global(.dialog-backdrop) {
    background: var(--overlay);
    inset: 0;
    position: fixed;
  }

  :global(.dialog-content) {
    box-sizing: border-box;
    position: fixed;
  }

  :global(.dialog-backdrop-drawer) {
    border: 0;
  }

  :global(.dialog-content-drawer) {
    border: 0;
    inset: var(--safe-top) var(--safe-right) var(--safe-bottom) auto;
    max-width: min(22rem, 85%);
    padding: 0;
    width: 100%;
  }

  :global(.dialog-content-fullscreen) {
    background: var(--bg-container);
    border: 0;
    border-radius: 0;
    inset: 0;
    overflow: hidden;
    padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
  }

  :global(.dialog-content-settings) {
    background: var(--surface-container);
    border: 0;
    border-radius: 0;
    box-shadow: var(--shadow-dialog);
    height: 100dvh;
    left: 50%;
    max-width: 68rem;
    overflow: hidden;
    padding-block: var(--safe-top) var(--safe-bottom);
    top: 50%;
    transform: translate(-50%, -50%);
    width: 100%;
  }

  :global(.dialog-content-verification),
  :global(.dialog-content-sheet) {
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radius) var(--radius) 0 0;
    bottom: 0;
    box-shadow: var(--shadow-dialog);
    max-height: calc(100dvh - var(--safe-top) - var(--safe-bottom) - var(--space-300) * 2);
    overflow: auto;
    padding: var(--space-400);

    /* Bottom-anchored, so the home indicator would otherwise sit on the content. */
    padding-bottom: calc(var(--space-400) + var(--safe-bottom));
    width: 100%;
  }

  /* Several dialog bodies cap themselves against the viewport. Keep those
     widths inside this panel's padded content box on narrow screens. */
  :global(.dialog-content-verification > *) {
    max-width: 100%;
  }

  :global(.dialog-content-sheet) {
    --sheet-inset-bottom: var(--safe-bottom);

    overscroll-behavior: contain;
    padding: 0 0 var(--safe-bottom);
  }

  :global(.dialog-content-sheet:has(> div > [data-inset-owner~='bottom'])) {
    padding-bottom: 0;
  }

  @media (width >= 42rem) {
    :global(.dialog-content-verification) {
      border-radius: var(--radius);
      bottom: auto;
      left: 50%;
      max-width: min(34rem, calc(100vw - 3rem));
      padding: var(--space-500);
      top: 50%;
      transform: translate(-50%, -50%);

      /* The mobile rule sets `width: 100%`, which held the panel at its max
         and left narrower content stranded against one edge. */
      width: fit-content;
    }
  }

  @media (width >= 48rem) {
    :global(.dialog-content-settings) {
      border: var(--border-width) solid var(--surface-container-line);
      border-radius: var(--radius);
      height: min(52rem, calc(100dvh - 3rem));
      width: calc(100% - 3rem);
    }
  }

  @keyframes dialog-backdrop-in {
    from {
      opacity: 0;
    }
  }

  @keyframes dialog-backdrop-out {
    to {
      opacity: 0;
    }
  }

  @keyframes dialog-in {
    from {
      opacity: 0;
      transform: translate(-50%, calc(-50% + var(--space-200))) scale(var(--scale-enter));
    }
  }

  @keyframes dialog-out {
    to {
      opacity: 0;
      transform: translate(-50%, calc(-50% + var(--space-200))) scale(var(--scale-enter));
    }
  }

  @keyframes sheet-in {
    from {
      filter: blur(var(--blur-small));
      opacity: 0;
      transform: translateY(var(--space-300));
    }
  }

  @keyframes sheet-out {
    to {
      opacity: 0;
      transform: translateY(var(--space-300));
    }
  }

  @keyframes drawer-in {
    from {
      filter: blur(var(--blur-small));
      transform: translateX(var(--space-400));
    }
  }

  @keyframes drawer-out {
    to {
      transform: translateX(var(--space-400));
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on']) .dialog-backdrop[data-state='open']) {
      animation: dialog-backdrop-in var(--duration-fast) var(--ease-smooth-out);
    }

    :global(html:not([data-reduced-motion='on']) .dialog-backdrop[data-state='closed']) {
      animation: dialog-backdrop-out var(--motion-normal) var(--ease-smooth-out);
    }

    :global(html:not([data-reduced-motion='on']) .dialog-content-drawer[data-state='open']) {
      animation: drawer-in var(--duration-slow) var(--ease-smooth-out);
    }

    :global(html:not([data-reduced-motion='on']) .dialog-content-drawer[data-state='closed']) {
      animation: drawer-out var(--duration-medium) var(--ease-smooth-out);
    }

    :global(html:not([data-reduced-motion='on']) .dialog-content-settings[data-state='open']),
    :global(html:not([data-reduced-motion='on']) .dialog-content-verification[data-state='open']),
    :global(html:not([data-reduced-motion='on']) .dialog-content-sheet[data-state='open']) {
      animation: sheet-in var(--duration-slow) var(--ease-smooth-out);
    }

    :global(html:not([data-reduced-motion='on']) .dialog-content-settings[data-state='closed']),
    :global(html:not([data-reduced-motion='on']) .dialog-content-verification[data-state='closed']),
    :global(html:not([data-reduced-motion='on']) .dialog-content-sheet[data-state='closed']) {
      animation: sheet-out var(--duration-medium) var(--ease-smooth-out);
    }

    :global(html:not([data-reduced-motion='on']) .dialog-content-sheet.sheet-settling) {
      transition: transform var(--duration-slow) var(--ease-smooth-out);
    }

    :global(.dialog-content-sheet.sheet-dragging) {
      transition: none;
    }
  }

  @media (prefers-reduced-motion: no-preference) and (width >= 42rem) {
    :global(html:not([data-reduced-motion='on']) .dialog-content-verification[data-state='open']) {
      animation: dialog-in var(--duration-fast) var(--ease-smooth-out);
    }

    :global(
      html:not([data-reduced-motion='on']) .dialog-content-verification[data-state='closed']
    ) {
      animation: dialog-out var(--motion-normal) var(--ease-smooth-out);
    }
  }

  @media (prefers-reduced-motion: no-preference) and (width >= 48rem) {
    :global(html:not([data-reduced-motion='on']) .dialog-content-settings[data-state='open']) {
      animation: dialog-in var(--duration-fast) var(--ease-smooth-out);
    }

    :global(html:not([data-reduced-motion='on']) .dialog-content-settings[data-state='closed']) {
      animation: dialog-out var(--motion-normal) var(--ease-smooth-out);
    }
  }
</style>
