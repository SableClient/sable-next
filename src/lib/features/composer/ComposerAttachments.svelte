<script lang="ts">
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
  import FileIcon from 'phosphor-svelte/lib/FileIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import { formatByteSize } from '#lib/ui/byte-size.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import { previewKind, type StagedFile } from './composer-files';
  import StagedMediaViewer from './StagedMediaViewer.svelte';
  import StagedThumbnail from './StagedThumbnail.svelte';

  interface Props {
    files: readonly StagedFile[];
    disabled?: boolean;
    onRemove: (id: number) => void;
    onToggleSpoiler: (id: number) => void;
  }

  let { files, disabled = false, onRemove, onToggleSpoiler }: Props = $props();

  let viewing = $state<number | null>(null);
  let media = $derived(files.filter((item) => previewKind(item.file) !== null));
</script>

<ul class="staged" aria-label={$i18n.t('composer.stagedFiles')}>
  {#each files as item (item.id)}
    {@const kind = previewKind(item.file)}
    <li class={['staged-item', kind ? 'staged-media' : 'staged-file']}>
      {#if kind}
        <StagedThumbnail
          file={item.file}
          {kind}
          spoiler={item.spoiler}
          onOpen={() => {
            viewing = item.id;
          }}
        />
        <span class="staged-name">{item.file.name}</span>
        <IconButton
          variant="ghost"
          size="small"
          class={['staged-control staged-spoiler', item.spoiler && 'staged-spoiler-on']}
          {disabled}
          aria-pressed={item.spoiler}
          label={$i18n.t('composer.spoilerAttachment', { name: item.file.name })}
          onclick={() => {
            onToggleSpoiler(item.id);
          }}
        >
          <EyeSlashIcon />
        </IconButton>
      {:else}
        <span class="staged-icon" aria-hidden="true"><FileIcon /></span>
        <span class="staged-text">
          <span class="staged-name">{item.file.name}</span>
          <span class="staged-size">{formatByteSize(item.file.size)}</span>
        </span>
      {/if}
      <IconButton
        variant="ghost"
        size="small"
        class="staged-control staged-remove"
        {disabled}
        label={$i18n.t('composer.removeAttachment', { name: item.file.name })}
        onclick={() => {
          onRemove(item.id);
        }}
      >
        <XIcon />
      </IconButton>
    </li>
  {/each}
</ul>

{#if viewing !== null}
  <StagedMediaViewer
    files={media}
    selectedId={viewing}
    onClose={() => {
      viewing = null;
    }}
    {onRemove}
    {onToggleSpoiler}
  />
{/if}

<style>
  .staged {
    display: flex;
    gap: var(--space-150);
    list-style: none;
    margin: 0;
    overflow: auto hidden;
    overscroll-behavior-x: contain;
    padding: var(--space-200) var(--space-200) 0;
    scroll-padding-inline: var(--space-200);
    scroll-snap-type: x proximity;
    scrollbar-width: thin;
  }

  .staged-item {
    --radius-outer: var(--radii-500);
    --radius-padding: var(--space-100);
    --radius-inner: max(0px, calc(var(--radius-outer) - var(--radius-padding)));

    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius-outer);
    flex: none;
    height: 5.5rem;
    position: relative;
    scroll-snap-align: start;
  }

  .staged-media {
    overflow: hidden;
    width: 5.5rem;
  }

  .staged-media .staged-name {
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  .staged-file {
    align-content: end;
    display: grid;
    gap: var(--space-100);
    max-width: 12rem;
    min-width: 8.5rem;
    padding: var(--space-200);
  }

  .staged-icon {
    color: var(--surface-var-on-container);
    display: flex;
    inset-block-start: var(--space-200);
    inset-inline-start: var(--space-200);
    position: absolute;
  }

  .staged-icon :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .staged-text {
    display: grid;
    line-height: 1.2;
    min-width: 0;
  }

  .staged-file .staged-name {
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .staged-size {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }

  .staged-item :global(.staged-control) {
    --button-height: var(--size-x500);
    --button-icon-size: var(--size-x50);

    border-radius: var(--radius-inner);
    position: absolute;
  }

  .staged-item :global(.staged-remove) {
    inset-block-start: var(--radius-padding);
    inset-inline-end: var(--radius-padding);
  }

  .staged-item :global(.staged-spoiler) {
    inset-block-end: var(--radius-padding);
    inset-inline-start: var(--radius-padding);
  }

  .staged-media :global(.staged-control) {
    --button-container: var(--media-scrim);
    --button-container-hover: var(--media-scrim);
    --button-container-active: var(--media-scrim);
    --button-on-container: var(--media-on-scrim);

    backdrop-filter: blur(0.5rem);
  }

  .staged-media :global(.staged-control.staged-spoiler-on) {
    --button-container: var(--warn-main);
    --button-container-hover: var(--warn-main-hover);
    --button-container-active: var(--warn-main-hover);
    --button-on-container: var(--warn-on-main);
  }
</style>
