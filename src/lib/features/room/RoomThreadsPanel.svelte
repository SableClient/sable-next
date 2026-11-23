<script lang="ts">
  import type { MemberView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import type { ThreadRoots } from '#lib/rooms/thread-roots.svelte.js';

  import ThreadList from './conversation/ThreadList.svelte';
  import RoomSidePanel from './RoomSidePanel.svelte';

  interface Props {
    roomId: string;
    threads: ThreadRoots;
    members: readonly MemberView[];
    onOpenThread: (rootEventId: string) => void;
    modal?: boolean;
    onClose: () => void;
  }

  let { roomId, threads, members, onOpenThread, modal = false, onClose }: Props = $props();
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
  <ThreadList {roomId} {threads} {members} {onOpenThread} />
</RoomSidePanel>
