<script lang="ts">
  import type { MemberView, RoomAttachmentKind } from '#src/generated/protocol';

  import type { MatrixLink } from '#lib/rooms/matrix-link.js';

  import RoomFileAttachments from './RoomFileAttachments.svelte';
  import RoomLinkAttachments from './RoomLinkAttachments.svelte';
  import RoomMediaAttachments from './RoomMediaAttachments.svelte';

  interface Props {
    kind: RoomAttachmentKind;
    roomId: string;
    members: readonly MemberView[];
    modal?: boolean;
    onJump: (eventId: string) => void;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onClose?: () => void;
  }

  let { kind, roomId, members, modal = false, onJump, onMatrixLink, onClose }: Props = $props();
</script>

<div role="tabpanel" id="attachments-panel" aria-labelledby={`attachments-tab-${kind}`}>
  {#if kind === 'media'}
    <RoomMediaAttachments {roomId} {members} {modal} {onJump} {onClose} />
  {:else if kind === 'file'}
    <RoomFileAttachments {roomId} {members} {modal} {onJump} {onClose} />
  {:else}
    <RoomLinkAttachments {roomId} {members} {modal} {onJump} {onMatrixLink} {onClose} />
  {/if}
</div>
