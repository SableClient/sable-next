<script lang="ts">
  import ImagesIcon from 'phosphor-svelte/lib/ImagesIcon';
  import type { MemberView } from '#src/generated/protocol';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import { i18n } from '#lib/i18n.js';

  import RoomAttachments from './media/RoomAttachments.svelte';
  import RoomSidePanel from './RoomSidePanel.svelte';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    onJump: (eventId: string) => void;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    modal?: boolean;
    onClose: () => void;
  }

  let { roomId, members, onJump, onMatrixLink, modal = false, onClose }: Props = $props();
</script>

<RoomSidePanel
  title={i18n.t('timeline.attachmentsTitle')}
  closeLabel={i18n.t('timeline.attachmentsClose')}
  resizeLabel={i18n.t('timeline.attachmentsResize')}
  widthKey="sable-attachments-width"
  width={22}
  body="none"
  {modal}
  {onClose}
>
  {#snippet icon()}
    <ImagesIcon aria-hidden="true" />
  {/snippet}
  <RoomAttachments {roomId} {members} {modal} {onJump} {onMatrixLink} {onClose} />
</RoomSidePanel>
