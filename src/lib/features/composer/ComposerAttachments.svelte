<script lang="ts">
  import FileIcon from 'phosphor-svelte/lib/FileIcon';
  import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
  import VideoIcon from 'phosphor-svelte/lib/VideoIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '$lib/i18n';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';

  import { formatSize, type StagedFile } from './composer-files';

  interface Props {
    files: readonly StagedFile[];
    disabled?: boolean;
    onRemove: (id: number) => void;
  }

  let { files, disabled = false, onRemove }: Props = $props();
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
        <span class="staged-size">{formatSize(item.file.size)}</span>
      </span>
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
    gap: 0.375rem;
    list-style: none;
    margin: 0;
    max-height: 7.5rem;
    overflow-y: auto;
    padding: 0.5rem 0.5rem 0;
  }

  .staged-item {
    align-items: center;
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    display: flex;
    gap: 0.375rem;
    max-width: 14rem;
    min-width: 0;
    padding: 0.25rem 0.25rem 0.25rem 0.5rem;
  }

  .staged-icon {
    align-items: center;
    color: var(--sable-surface-var-on-container);
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
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  :global(.staged-remove) {
    flex: 0 0 auto;
  }

  :global(.staged-remove svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }
</style>
