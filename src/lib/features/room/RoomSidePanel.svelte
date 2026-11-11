<script lang="ts">
  import { onMount, untrack, type Snippet } from 'svelte';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import { PanelWidth, remFromPixels } from '#lib/ui/panel-width.svelte.js';
  import { scrollHint } from '#lib/ui/scroll-hint.js';
  import { panelIn, panelOut, usePanelStage } from '#lib/ui/motion.js';

  interface Props {
    title: string;
    closeLabel: string;
    resizeLabel: string;
    widthKey: string;
    width?: number;
    modal?: boolean;
    /** `none` hands the area under the header to `children`, which then scroll themselves. */
    body?: 'padded' | 'flush' | 'none';
    icon: Snippet;
    children: Snippet;
    onClose: () => void;
  }

  let {
    title,
    closeLabel,
    resizeLabel,
    widthKey,
    width = 26,
    modal = false,
    body: bodyStyle = 'padded',
    icon,
    children,
    onClose,
  }: Props = $props();
  const stage = usePanelStage();

  const panelWidth = untrack(() => new PanelWidth(widthKey, width, 16, 40));
  onMount(() => panelWidth.restore());
</script>

{#snippet body()}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <aside
    class={['side-panel', { modal }]}
    onkeydown={(event) => {
      if (modal || event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    }}
    aria-label={title}
    data-focus-region="panel"
    style:width={modal ? null : `${panelWidth.width}rem`}
    in:panelIn|global={{ modal, stage }}
    out:panelOut|global={{ modal, stage }}
  >
    {#if !modal}
      <ResizeHandle
        value={panelWidth.width}
        min={panelWidth.min}
        max={panelWidth.max}
        label={resizeLabel}
        grow="left"
        step={1}
        fromPixels={remFromPixels}
        onResize={(next) => panelWidth.resize(next)}
        onCommit={() => panelWidth.commit()}
      />
    {/if}
    <PanelHeader {title}>
      {#snippet prefix()}
        {@render icon()}
      {/snippet}
      {#snippet suffix()}
        <PanelHeaderButton label={closeLabel} onclick={onClose}>
          <XIcon />
        </PanelHeaderButton>
      {/snippet}
    </PanelHeader>
    {#if bodyStyle === 'none'}
      {@render children()}
    {:else}
      <div class={['side-panel-body', bodyStyle]} {@attach scrollHint}>
        {@render children()}
      </div>
    {/if}
  </aside>
{/snippet}

{#if modal}
  <DialogFrame
    open
    onOpenChange={(open: boolean) => {
      if (!open) onClose();
    }}
    variant="drawer"
    label={title}
  >
    {@render body()}
  </DialogFrame>
{:else}
  {@render body()}
{/if}

<style>
  .side-panel {
    --ghost-hover: var(--bg-container-hover);
    --ghost-active: var(--bg-container-active);

    background: var(--bg-container);
    border-left: var(--border-width) solid var(--bg-container-line);
    color: var(--bg-on-container);
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    min-height: 0;
    position: relative;
  }

  .side-panel.modal {
    border-left: none;
    height: 100%;
    width: 100%;
  }

  .side-panel :global(.resize-handle) {
    left: -0.25rem;
    z-index: 1;
  }

  .side-panel-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .side-panel-body.padded {
    padding: var(--space-300);
  }
</style>
