<script lang="ts">
  import { Popover } from 'bits-ui';
  import { page } from '$app/state';
  import { tick } from 'svelte';
  import { i18n } from '#lib/i18n.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import InboxView from './InboxView.svelte';

  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let anchor = $state<HTMLAnchorElement | null>(null);
  let desktop = $derived(appLayout.matches);

  $effect(() => {
    void tick().then(() => {
      anchor =
        Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href="/inbox"].active')).find(
          (element) => element.getClientRects().length > 0
        ) ?? null;
    });
  });

  function close(): void {
    history.back();
  }
</script>

{#if desktop && anchor}
  <Popover.Root
    open={page.state.inbox === true}
    onOpenChange={(open) => {
      if (!open) close();
    }}
  >
    <Popover.Portal>
      <Popover.Content
        class="inbox-popover"
        customAnchor={anchor}
        side="top"
        align="end"
        sideOffset={8}
      >
        <InboxView onClose={close} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{:else}
  <BottomSheet
    open={page.state.inbox === true}
    label={$i18n.t('nav.inbox')}
    closeLabel={$i18n.t('settings.close')}
    onOpenChange={(open) => {
      if (!open) close();
    }}
  >
    <InboxView onClose={close} />
  </BottomSheet>
{/if}

<style>
  :global(.inbox-popover) {
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    max-height: min(42rem, calc(100dvh - 2rem));
    overflow: auto;
    width: min(24rem, calc(100vw - 2rem));
    z-index: var(--layer-popover);
  }
</style>
