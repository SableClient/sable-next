<script lang="ts">
  import type { MemberView } from '@/generated/MemberView';
  import type { ProfileView } from '@/generated/ProfileView';
  import { Popover } from 'bits-ui';

  import { BREAKPOINTS } from '$lib/ui/breakpoints';
  import { i18n } from '$lib/i18n';
  import { createMediaQuery } from '$lib/ui/media-query.svelte';
  import BottomSheet from '$lib/ui/primitives/BottomSheet.svelte';

  import MentionProfileCard from './MentionProfileCard.svelte';
  import type { MatrixLink } from './matrix-link';

  interface Props {
    open?: boolean;
    userId: string | null;
    member: MemberView | null;
    profile?: ProfileView | null;
    anchor: HTMLElement | null;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onOpenChange?: (open: boolean) => void;
  }

  let {
    open = $bindable(false),
    userId,
    member,
    profile = null,
    anchor,
    onMatrixLink,
    onOpenChange,
  }: Props = $props();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let desktop = $derived(appLayout.matches);
  function handleOpenChange(next: boolean): void {
    onOpenChange?.(next);
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
      >
        {#if userId}
          <MentionProfileCard {userId} {member} {profile} {onMatrixLink} />
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
      <MentionProfileCard {userId} {member} {profile} {onMatrixLink} />
    {/if}
  </BottomSheet>
{/if}

<style>
  :global(.mention-profile-popover) {
    box-shadow: var(--shadow-dialog);
    padding: 0;
    width: min(22rem, calc(100vw - 2rem));
    z-index: calc(var(--layer-popover) + 1);
  }
</style>
