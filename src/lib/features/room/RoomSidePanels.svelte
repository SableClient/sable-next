<script lang="ts">
  import type { MemberView, MembershipView, RoomListItemView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import WidgetsPanel from '#lib/features/widgets/WidgetsPanel.svelte';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import type { RoomMemberLoader } from '#lib/rooms/room-members.svelte.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import ThreadList from './conversation/ThreadList.svelte';
  import RoomAttachments from './media/RoomAttachments.svelte';
  import MembersDrawer from './members/MembersDrawer.svelte';
  import RoomNotificationsPanel from './RoomNotificationsPanel.svelte';
  import RoomSearchPanel from './RoomSearchPanel.svelte';
  import type { RoomPanels } from './room-panels.svelte.js';
  import type { RoomSession } from './room-session.svelte.js';
  import { scopedSearchQuery } from './room-navigation.js';

  interface Props {
    panels: RoomPanels;
    room: RoomListItemView | undefined;
    roomId: string;
    desktop: boolean;
    memberLoader: RoomMemberLoader;
    roomSession: RoomSession;
    canManageWidgets: boolean;
    onOpenThread: (rootEventId: string) => void;
    onJump: (eventId: string) => void;
    onMatrixLink: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onMemberProfile: (userId: string, anchor: HTMLElement) => void;
  }

  let {
    panels,
    room,
    roomId,
    desktop,
    memberLoader,
    roomSession,
    canManageWidgets,
    onOpenThread,
    onJump,
    onMatrixLink,
    onMemberProfile,
  }: Props = $props();
  const core = useCoreClient();

  let ownMember = $derived(
    memberLoader.members.find((member) => member.user_id === core.session?.user_id) ?? null
  );
  let drawerMembers = $derived(memberLoader.roomId === roomId ? memberLoader.members : []);
  let membersLoading = $derived(memberLoader.roomId !== roomId || memberLoader.loading);

  function loadMembership(membership: MembershipView): Promise<MemberView[]> {
    return core.rpc.members.list({ room_id: roomId, memberships: [membership] });
  }

  function closeWidgets(): void {
    panels.widgetsOpen = false;
  }

  async function addWidget(name: string, url: string): Promise<void> {
    try {
      await roomSession.details.addWidget(name, url);
    } catch (error) {
      console.warn('[sable room] add widget failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
    }
  }

  async function removeWidget(widgetId: string): Promise<void> {
    try {
      await roomSession.details.removeWidget(widgetId);
    } catch (error) {
      console.warn('[sable room] remove widget failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
    }
  }
</script>

{#if panels.threadsOpen}
  <ThreadList
    {roomId}
    members={memberLoader.members}
    modal={!desktop}
    {onOpenThread}
    onClose={() => (panels.threadsOpen = false)}
  />
{/if}

{#if panels.searchOpen}
  {#key roomId}
    <RoomSearchPanel
      query={scopedSearchQuery('in', room, roomId)}
      modal={!desktop}
      onClose={() => (panels.searchOpen = false)}
    />
  {/key}
{/if}

{#if panels.notificationsOpen}
  {#key roomId}
    <RoomNotificationsPanel
      {roomId}
      members={memberLoader.members}
      modal={!desktop}
      {onJump}
      onClose={() => (panels.notificationsOpen = false)}
    />
  {/key}
{/if}

{#if panels.attachmentsOpen}
  <RoomAttachments
    {roomId}
    members={memberLoader.members}
    modal={!desktop}
    {onJump}
    {onMatrixLink}
    onClose={() => (panels.attachmentsOpen = false)}
  />
{/if}

{#if desktop}
  {#if panels.desktopMembersOpen && panels.threadRootId === null}
    <MembersDrawer
      {roomId}
      members={drawerMembers}
      loading={membersLoading}
      powerTags={roomSession.powerTags}
      alwaysListedFrom={roomSession.alwaysListedFrom}
      {loadMembership}
      {onMemberProfile}
    />
  {/if}
  {#if panels.widgetsOpen}
    <WidgetsPanel
      {roomId}
      widgets={roomSession.widgets}
      userId={core.session?.user_id ?? ''}
      displayName={ownMember?.display_name ?? core.session?.user_id ?? ''}
      avatarUrl={ownMember?.avatar_url ?? ''}
      canManage={canManageWidgets}
      onClose={closeWidgets}
      onAdd={addWidget}
      onRemove={removeWidget}
    />
  {/if}
{:else}
  <DialogFrame bind:open={panels.membersOpen} variant="drawer">
    <MembersDrawer
      {roomId}
      members={drawerMembers}
      loading={membersLoading}
      modal
      powerTags={roomSession.powerTags}
      alwaysListedFrom={roomSession.alwaysListedFrom}
      {loadMembership}
      {onMemberProfile}
    />
  </DialogFrame>
{/if}

{#if !desktop}
  <DialogFrame
    open={panels.widgetsOpen}
    onOpenChange={(open: boolean) => {
      if (!open) closeWidgets();
    }}
    variant="drawer"
  >
    <WidgetsPanel
      {roomId}
      widgets={roomSession.widgets}
      userId={core.session?.user_id ?? ''}
      displayName={ownMember?.display_name ?? core.session?.user_id ?? ''}
      avatarUrl={ownMember?.avatar_url ?? ''}
      canManage={canManageWidgets}
      modal
      onClose={closeWidgets}
      onAdd={addWidget}
      onRemove={removeWidget}
    />
  </DialogFrame>
{/if}
