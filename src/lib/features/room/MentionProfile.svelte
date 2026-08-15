<script lang="ts">
  import type { MemberView } from '@/generated/MemberView';
  import type { ProfileView } from '@/generated/ProfileView';
  import type { RoomPermissionsView } from '@/generated/RoomPermissionsView';
  import { Popover } from 'bits-ui';

  import { BREAKPOINTS } from '$lib/ui/breakpoints';
  import { i18n } from '$lib/i18n';
  import { createMediaQuery } from '$lib/ui/media-query.svelte';
  import BottomSheet from '$lib/ui/primitives/BottomSheet.svelte';

  import MentionProfileCard from './MentionProfileCard.svelte';

  interface Props {
    open?: boolean;
    userId: string | null;
    member: MemberView | null;
    roomId: string;
    ownPowerLevel?: number;
    permissions?: RoomPermissionsView | null;
    profile?: ProfileView | null;
    failed?: boolean;
    anchor: HTMLElement | null;
    onOpenChange?: (open: boolean) => void;
  }

  let {
    open = $bindable(false),
    userId,
    member,
    roomId,
    ownPowerLevel = 0,
    permissions = null,
    profile = null,
    failed = false,
    anchor,
    onOpenChange,
  }: Props = $props();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let desktop = $derived(appLayout.matches);

  $effect(() => {
    if (!open || !desktop || !anchor) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) onOpenChange?.(false);
    });
    observer.observe(anchor);
    return () => {
      observer.disconnect();
    };
  });

  function handleOpenChange(next: boolean): void {
    onOpenChange?.(next);
  }

  function handleCloseAutoFocus(event: Event): void {
    event.preventDefault();
    anchor?.focus({ preventScroll: true });
  }
</script>

{#if desktop && anchor}
  <Popover.Root bind:open onOpenChange={handleOpenChange}>
    <Popover.Portal>
      <Popover.Content
        class="mention-profile-popover"
        customAnchor={anchor}
        side="top"
        align="start"
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        {#if userId}
          <MentionProfileCard
            {userId}
            {member}
            {roomId}
            {ownPowerLevel}
            {permissions}
            {profile}
            {failed}
          />
        {/if}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{:else}
  <BottomSheet
    bind:open
    label={$i18n.t('timeline.userProfile')}
    closeLabel={$i18n.t('timeline.closeProfile')}
    onOpenChange={handleOpenChange}
  >
    {#if userId}
      <MentionProfileCard
        {userId}
        {member}
        {roomId}
        {ownPowerLevel}
        {permissions}
        {profile}
        {failed}
        variant="sheet"
      />
    {/if}
  </BottomSheet>
{/if}

<style>
  :global(.mention-profile-popover) {
    box-shadow: var(--shadow-dialog);
    padding: 0;
    width: min(22rem, calc(100vw - 2rem));
    z-index: var(--layer-popover);
  }
</style>
