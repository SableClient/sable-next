<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  interface Props {
    urls: readonly string[];
    onDismiss: (url: string) => void;
  }

  let { urls, onDismiss }: Props = $props();
</script>

<ul class="previews" aria-label={$i18n.t('composer.linkPreviews')}>
  {#each urls as url (url)}
    <li class="preview">
      <span class="preview-url">{url}</span>
      <IconButton
        size="small"
        variant="ghost"
        label={$i18n.t('composer.skipLinkPreview', { url })}
        onclick={() => onDismiss(url)}
      >
        <XIcon />
      </IconButton>
    </li>
  {/each}
</ul>

<style>
  .previews {
    border-bottom: var(--border-width) solid var(--surface-container-line);
    color: var(--surface-var-on-container);
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-small);
    list-style: none;
    margin: 0 var(--space-150);
    padding: var(--space-100) 0;
  }

  .preview {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    min-width: 0;
  }

  .preview-url {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
