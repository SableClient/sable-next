<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import ResponsiveInfoDialog from '#lib/ui/primitives/ResponsiveInfoDialog.svelte';
  import type { SharedByView } from '#src/generated/protocol';
  import KeychainIcon from './KeychainIcon.svelte';

  interface Props {
    sharedBy: SharedByView;
  }

  const { sharedBy }: Props = $props();

  let detailsOpen = $state(false);
  let name = $derived(sharedBy.name ?? sharedBy.user_id);
</script>

<button
  type="button"
  class="message-shared-by"
  aria-label={i18n.t('timeline.sharedBy.label', { name })}
  aria-haspopup="dialog"
  onclick={() => {
    detailsOpen = true;
  }}
>
  <KeychainIcon />
</button>

<ResponsiveInfoDialog
  bind:open={detailsOpen}
  label={i18n.t('timeline.sharedBy.title')}
  closeLabel={i18n.t('common.close')}
>
  {#snippet header()}
    <KeychainIcon />
    <h2>{i18n.t('timeline.sharedBy.title')}</h2>
  {/snippet}

  {#snippet body()}
    <p>{i18n.t('timeline.sharedBy.body', { name })}</p>
  {/snippet}
</ResponsiveInfoDialog>

<style>
  .message-shared-by {
    align-self: flex-start;
    background: none;
    border: 0;
    cursor: pointer;
    font: inherit;
    line-height: 0;
    margin-inline-start: var(--space-200);
    padding: 0;

    :global(svg) {
      color: var(--sec-main);
      font-size: var(--font-size-body);
    }

    &:hover :global(svg) {
      color: var(--sec-main-hover);
    }

    &:active :global(svg) {
      color: var(--sec-main-active);
    }
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  @media (prefers-reduced-motion: no-preference) {
    .message-shared-by:active {
      scale: 0.96;
    }

    :global(html:not([data-reduced-motion='on'])) .message-shared-by {
      transition: scale var(--motion-fast) var(--ease-smooth-out);
    }
  }
</style>
