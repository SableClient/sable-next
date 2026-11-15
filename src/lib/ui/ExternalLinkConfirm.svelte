<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { externalLinkRequest } from '#lib/platform/external-link-request.svelte.js';
  import { openAppLink } from '#lib/platform/external-links.js';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';

  let url = $derived(externalLinkRequest.current);

  function open(): void {
    const href = url;
    externalLinkRequest.current = null;
    if (href === null) return;
    void openAppLink(href).catch((error: unknown) => {
      console.warn('[sable links] app link unavailable', href, error);
    });
  }
</script>

{#if url !== null}
  <ConfirmDialog
    open
    title={i18n.t('externalLink.title')}
    description={i18n.t('externalLink.description')}
    confirmLabel={i18n.t('externalLink.confirm')}
    confirmVariant="primary"
    onConfirm={open}
    onOpenChange={(open) => {
      if (!open) externalLinkRequest.current = null;
    }}
  >
    <p class="external-link-url">{url}</p>
  </ConfirmDialog>
{/if}

<style>
  .external-link-url {
    font-family: var(--font-family-mono);
    margin: 0;
    max-height: 8rem;
    overflow-wrap: anywhere;
    overflow-y: auto;
    user-select: text;
  }
</style>
