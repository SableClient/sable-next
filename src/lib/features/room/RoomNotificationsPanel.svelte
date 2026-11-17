<script lang="ts">
  import TrayIcon from 'phosphor-svelte/lib/TrayIcon';
  import type { MemberView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';

  import RoomNotifications from './RoomNotifications.svelte';
  import RoomSidePanel from './RoomSidePanel.svelte';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    onJump: (eventId: string) => void;
    modal?: boolean;
    onClose: () => void;
  }

  let { roomId, members, onJump, modal = false, onClose }: Props = $props();
</script>

<RoomSidePanel
  title={i18n.t('inbox.notifications')}
  closeLabel={i18n.t('room.notificationsClose')}
  resizeLabel={i18n.t('room.notificationsResize')}
  widthKey="sable-room-notifications-width"
  width={22}
  body="none"
  {modal}
  {onClose}
>
  {#snippet icon()}
    <TrayIcon aria-hidden="true" />
  {/snippet}
  <RoomNotifications {roomId} {members} {onJump} />
</RoomSidePanel>
