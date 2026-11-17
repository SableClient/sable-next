<script lang="ts">
  import type { MemberView, MembershipView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import type { RoomMemberLoader } from '#lib/rooms/room-members.svelte.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import MembersDrawer from './members/MembersDrawer.svelte';
  import type { RoomPanels } from './room-panels.svelte.js';
  import type { RoomSession } from './room-session.svelte.js';

  interface Props {
    panels: RoomPanels;
    roomId: string;
    desktop: boolean;
    memberLoader: RoomMemberLoader;
    roomSession: RoomSession;
    onMemberProfile: (userId: string, anchor: HTMLElement) => void;
  }

  let { panels, roomId, desktop, memberLoader, roomSession, onMemberProfile }: Props = $props();
  const core = useCoreClient();

  let drawerMembers = $derived(memberLoader.roomId === roomId ? memberLoader.members : []);
  let membersLoading = $derived(memberLoader.roomId !== roomId || memberLoader.loading);

  function loadMembership(membership: MembershipView): Promise<MemberView[]> {
    return core.rpc.members.list({ room_id: roomId, memberships: [membership] });
  }
</script>

{#snippet drawer(modal: boolean)}
  <MembersDrawer
    {roomId}
    members={drawerMembers}
    loading={membersLoading}
    {modal}
    powerTags={roomSession.powerTags}
    alwaysListedFrom={roomSession.alwaysListedFrom}
    {loadMembership}
    {onMemberProfile}
  />
{/snippet}

{#if desktop}
  {#if panels.desktopMembersOpen && panels.threadRootId === null}
    {@render drawer(false)}
  {/if}
{:else}
  <DialogFrame bind:open={panels.membersOpen} variant="drawer">
    {@render drawer(true)}
  </DialogFrame>
{/if}
