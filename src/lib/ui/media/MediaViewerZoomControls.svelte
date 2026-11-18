<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import ImageSquareIcon from 'phosphor-svelte/lib/ImageSquareIcon';
  import MinusIcon from 'phosphor-svelte/lib/MinusIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';

  interface Props {
    zoom: number;
    showOriginal: boolean;
    editing: boolean;
    zoomInput: string;
    onoriginal: () => void;
    onzoomout: () => void;
    onzoomin: () => void;
    onedit: () => void;
    oncommit: () => void;
  }

  let {
    zoom,
    showOriginal,
    editing,
    zoomInput = $bindable(),
    onoriginal,
    onzoomout,
    onzoomin,
    onedit,
    oncommit,
  }: Props = $props();
</script>

{#if showOriginal}
  <IconButton
    label={i18n.t('viewer.originalSize')}
    size="small"
    variant="ghost"
    onclick={onoriginal}><ImageSquareIcon /></IconButton
  >
{/if}
<IconButton label={i18n.t('viewer.zoomOut')} size="small" variant="ghost" onclick={onzoomout}
  ><MinusIcon /></IconButton
>
{#if editing}
  <span class="zoom-level">
    <!-- svelte-ignore a11y_autofocus -->
    <input
      type="text"
      inputmode="numeric"
      aria-label={i18n.t('viewer.setZoom')}
      autofocus
      bind:value={zoomInput}
      onblur={oncommit}
      onkeydown={(event) => {
        if (event.key === 'Enter') oncommit();
      }}
    />%
  </span>
{:else}
  {@const zoomLabel = i18n.t('viewer.setZoom')}
  <Tooltip label={zoomLabel}>
    {#snippet trigger({ props })}
      <button {...props} class="zoom-level" type="button" onclick={onedit}
        >{Math.round(zoom * 100)}%</button
      >
    {/snippet}
  </Tooltip>
{/if}
<IconButton label={i18n.t('viewer.zoomIn')} size="small" variant="ghost" onclick={onzoomin}
  ><PlusIcon /></IconButton
>

<style>
  .zoom-level {
    background: none;
    border: 0;
    color: inherit;
    cursor: text;
    font: inherit;
    min-width: 4em;
    padding: 0;
    text-align: center;
  }

  .zoom-level input {
    all: unset;
    field-sizing: content;
    text-align: center;
  }
</style>
