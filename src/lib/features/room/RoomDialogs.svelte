<script lang="ts">
  import type { RoomListItemView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import JumpToTimeDialog from './timeline/JumpToTimeDialog.svelte';
  import LeaveRoomDialog from './LeaveRoomDialog.svelte';
  import MessageReportDialog from './messages/MessageReportDialog.svelte';
  import { sendReport } from './messages/report';
  import RoomInviteDialog from './RoomInviteDialog.svelte';
  import RoomSettingsDialog from './settings/RoomSettingsDialog.svelte';
  import RoomTopicViewer from './RoomTopicViewer.svelte';
  import { leaveRoomView } from './room-navigation.js';

  interface Props {
    room: RoomListItemView | undefined;
    roomId: string;
    roomName: string;
    topic: string | null;
    topicOpen: boolean;
    inviteOpen: boolean;
    jumpOpen: boolean;
    reportOpen: boolean;
    leaveOpen: boolean;
    settingsOpen: boolean;
    onJump: (eventId: string) => void;
    onMatrixLink: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
  }

  let {
    room,
    roomId,
    roomName,
    topic,
    topicOpen = $bindable(),
    inviteOpen = $bindable(),
    jumpOpen = $bindable(),
    reportOpen = $bindable(),
    leaveOpen = $bindable(),
    settingsOpen = $bindable(),
    onJump,
    onMatrixLink,
  }: Props = $props();
  const core = useCoreClient();
</script>

<RoomTopicViewer
  open={topicOpen}
  {roomName}
  topic={topic ?? ''}
  topicHtml={room?.topic_html ?? null}
  onOpenChange={(open: boolean) => {
    topicOpen = open;
  }}
  onMatrixLink={(link, anchor) => {
    topicOpen = false;
    onMatrixLink(link, anchor);
  }}
/>

<RoomInviteDialog
  open={inviteOpen}
  room={room ?? null}
  onOpenChange={(open: boolean) => {
    inviteOpen = open;
  }}
/>

<JumpToTimeDialog
  open={jumpOpen}
  {roomId}
  onOpenChange={(open: boolean) => {
    jumpOpen = open;
  }}
  {onJump}
/>

<MessageReportDialog
  bind:open={reportOpen}
  title={i18n.t(room?.room_kind === 'space' ? 'room.menuReportSpace' : 'room.menuReport')}
  hint={i18n.t('room.reportHint')}
  onReport={(reason) => {
    const target = roomId;
    void sendReport(() => core.rpc.rooms.report({ room_id: target, reason: reason ?? '' }));
  }}
/>

<LeaveRoomDialog
  open={leaveOpen}
  room={room ?? null}
  onOpenChange={(open: boolean) => {
    leaveOpen = open;
  }}
  onLeft={leaveRoomView}
/>

<RoomSettingsDialog
  open={settingsOpen}
  room={room ?? null}
  onOpenChange={(open: boolean) => {
    settingsOpen = open;
  }}
/>
