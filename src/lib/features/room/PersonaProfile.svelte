<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Popover } from 'bits-ui';
  import type { PerMessageProfileView } from '#src/generated/PerMessageProfileView';

  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { i18n } from '#lib/i18n.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';

  import PersonaCard from './PersonaCard.svelte';
  import './avatar-button.css';

  interface Props {
    profile: PerMessageProfileView;
    accountId: string;
    accountName: string;
    label: string;
    onOpenAccount: () => void;
    onOpenChange?: (open: boolean) => void;
    children: Snippet;
  }

  let { profile, accountId, accountName, label, onOpenAccount, onOpenChange, children }: Props =
    $props();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let desktop = $derived(appLayout.matches);
  let open = $state(false);
  let trigger = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!open || !desktop || !trigger) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) {
        open = false;
        onOpenChange?.(false);
      }
    });
    observer.observe(trigger);
    return () => {
      observer.disconnect();
    };
  });

  function handleOpenChange(next: boolean): void {
    onOpenChange?.(next);
  }

  function openSheet(): void {
    open = true;
    onOpenChange?.(true);
  }

  function openAccount(): void {
    open = false;
    onOpenChange?.(false);
    onOpenAccount();
  }
</script>

{#if desktop}
  <Popover.Root bind:open onOpenChange={handleOpenChange}>
    <Popover.Trigger bind:ref={trigger} class="avatar-button" aria-label={label}>
      {@render children()}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        class="persona-profile-popover"
        side="top"
        align="start"
        collisionPadding={12}
      >
        <PersonaCard {profile} {accountId} {accountName} onOpenAccount={openAccount} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{:else}
  <button class="avatar-button" type="button" aria-label={label} onclick={openSheet}>
    {@render children()}
  </button>
  <BottomSheet
    bind:open
    label={$i18n.t('timeline.personaSheet')}
    closeLabel={$i18n.t('timeline.closeProfile')}
    handleColor="var(--sable-bg-container)"
    handleOpacity={1}
    contentInset={false}
    onOpenChange={handleOpenChange}
  >
    <PersonaCard {profile} {accountId} {accountName} onOpenAccount={openAccount} variant="sheet" />
  </BottomSheet>
{/if}

<style>
  :global(.persona-profile-popover) {
    box-shadow: var(--shadow-dialog);
    padding: 0;
    width: min(22rem, calc(100vw - 2rem));
    z-index: var(--layer-popover);
  }
</style>
