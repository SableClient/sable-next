<script lang="ts">
  import { Popover } from 'bits-ui';
  import { page } from '$app/state';
  import { tick } from 'svelte';
  import { i18n } from '#lib/i18n.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import InboxView from './InboxView.svelte';

  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  const headingId = $props.id();
  let anchor = $state<HTMLAnchorElement | null>(null);
  let desktop = $derived(appLayout.matches);

  $effect(() => {
    void tick().then(() => {
      anchor =
        Array.from(
          document.querySelectorAll<HTMLAnchorElement>('a[href="/inbox"][aria-current="page"]')
        ).find((element) => element.getClientRects().length > 0) ?? null;
    });
  });

  function close(): void {
    history.back();
  }

  function focusHeading(event: Event): void {
    const heading = document.getElementById(headingId);
    if (!heading) return;
    event.preventDefault();
    heading.focus();
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
        {...overlayLayer()}
        customAnchor={anchor}
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        onOpenAutoFocus={focusHeading}
      >
        <InboxView variant="sheet" {headingId} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{:else}
  <BottomSheet
    ownsBack
    open={page.state.inbox === true}
    label={$i18n.t('nav.inbox')}
    closeLabel={$i18n.t('inbox.close')}
    background="var(--surface-container)"
    handleColor="var(--surface-on-container)"
    contentInset
    onOpenChange={(open) => {
      if (!open) close();
    }}
    onOpenAutoFocus={focusHeading}
  >
    <InboxView variant="sheet" {headingId} />
  </BottomSheet>
{/if}

<style>
  :global(.inbox-popover) {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    max-height: min(42rem, calc(100dvh - 2rem));
    overflow: auto;
    width: min(24rem, calc(100vw - 2rem));
  }
</style>
