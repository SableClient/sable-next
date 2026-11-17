<script lang="ts">
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import type { MemberView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';

  import ThreadList from './conversation/ThreadList.svelte';
  import RoomSidePanel from './RoomSidePanel.svelte';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    onOpenThread: (rootEventId: string) => void;
    modal?: boolean;
    onClose: () => void;
  }

  let { roomId, members, onOpenThread, modal = false, onClose }: Props = $props();
</script>

<RoomSidePanel
  title={i18n.t('timeline.threadsTitle')}
  closeLabel={i18n.t('timeline.threadsClose')}
  resizeLabel={i18n.t('timeline.threadsResize')}
  widthKey="sable-thread-list-width"
  width={22}
  body="flush"
  {modal}
  {onClose}
>
  {#snippet icon()}
    <ChatsIcon aria-hidden="true" />
  {/snippet}
  <ThreadList {roomId} {members} {onOpenThread} />
</RoomSidePanel>
