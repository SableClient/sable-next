<script lang="ts">
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
  import FileIcon from 'phosphor-svelte/lib/FileIcon';
  import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
  import VideoIcon from 'phosphor-svelte/lib/VideoIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import { formatByteSize } from '#lib/ui/byte-size.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import { canSpoiler, type StagedFile } from './composer-files';

  interface Props {
    files: readonly StagedFile[];
    disabled?: boolean;
    onRemove: (id: number) => void;
    onToggleSpoiler: (id: number) => void;
  }

  let { files, disabled = false, onRemove, onToggleSpoiler }: Props = $props();
</script>

<ul class="staged" aria-label={$i18n.t('composer.stagedFiles')}>
  {#each files as item (item.id)}
    <li class="staged-item">
      <span class="staged-icon" aria-hidden="true">
        {#if item.file.type.startsWith('image/')}
          <ImageIcon />
        {:else if item.file.type.startsWith('video/')}
          <VideoIcon />
        {:else}
          <FileIcon />
        {/if}
      </span>
      <span class="staged-text">
        <span class="staged-name">{item.file.name}</span>
        <span class="staged-size">{formatByteSize(item.file.size)}</span>
      </span>
      {#if canSpoiler(item.file)}
        <IconButton
          variant="ghost"
          size="small"
          class={['staged-spoiler', item.spoiler && 'staged-spoiler-on']}
          {disabled}
          aria-pressed={item.spoiler}
          label={$i18n.t('composer.spoilerAttachment', { name: item.file.name })}
          onclick={() => {
            onToggleSpoiler(item.id);
          }}
        >
          <EyeSlashIcon />
        </IconButton>
      {/if}
      <IconButton
        variant="ghost"
        size="small"
        class="staged-remove"
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

<style>
  .staged {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-150);
    list-style: none;
    margin: 0;
    max-height: 7.5rem;
    overflow-y: auto;
    padding: var(--space-200) var(--space-200) 0;
  }

  .staged-item {
    --radius-outer: var(--radius);
    --radius-padding: var(--space-100);
    --radius-inner: max(0px, calc(var(--radius-outer) - var(--radius-padding)));

    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius-outer);
    display: flex;
    gap: var(--space-150);
    max-width: 14rem;
    min-width: 0;
    padding: var(--radius-padding) var(--radius-padding) var(--radius-padding) var(--space-200);
  }

  .staged-icon {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
  }

  .staged-icon :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .staged-text {
    display: grid;
    line-height: 1.15;
    min-width: 0;
  }

  .staged-name {
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .staged-size {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .staged-item :global(.staged-remove),
  .staged-item :global(.staged-spoiler) {
    border-radius: var(--radius-inner);
    flex: 0 0 auto;
  }

  .staged-item :global(.staged-spoiler-on) {
    color: var(--warn-main);
  }

  :global(.staged-remove svg),
  :global(.staged-spoiler svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }
</style>
