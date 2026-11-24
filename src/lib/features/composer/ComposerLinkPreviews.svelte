<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { SvelteSet } from 'svelte/reactivity';

  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import type { UrlPreviewView } from '#src/generated/protocol';

  const LOADING_DELAY_MS = 200;

  interface Props {
    urls: readonly string[];
    onDismiss: (url: string) => void;
    loadLinkPreview?: (url: string) => Promise<UrlPreviewView | null>;
  }

  let { urls, onDismiss, loadLinkPreview }: Props = $props();
  const loading = new SvelteSet<string>();

  function trackPreview(url: string): (() => void) | undefined {
    if (!loadLinkPreview) return;
    let active = true;
    const timer = setTimeout(() => loading.add(url), LOADING_DELAY_MS);
    const finish = () => {
      clearTimeout(timer);
      if (active) loading.delete(url);
    };
    void loadLinkPreview(url).then(finish, finish);
    return () => {
      finish();
      active = false;
    };
  }
</script>

<ul class="previews" aria-label={i18n.t('composer.linkPreviews')}>
  {#each urls as url (url)}
    <li class="preview" {@attach () => trackPreview(url)}>
      <span class="preview-url">{url}</span>
      <span class="preview-status" role="status">
        {#if loading.has(url)}
          <Spinner small />
          {i18n.t('composer.loadingLinkPreview')}
        {/if}
      </span>
      <IconButton
        size="small"
        variant="ghost"
        label={i18n.t('composer.skipLinkPreview', { url })}
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

  .preview-status:not(:empty) {
    align-items: center;
    display: inline-flex;
    gap: var(--space-100);
  }

  .preview-status:empty {
    position: absolute;
  }
</style>
