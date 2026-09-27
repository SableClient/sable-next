<script lang="ts">
  import type { RoomJoinRuleView, TimelineItemView } from '#src/generated/protocol';

  import MessageBody from './MessageBody.svelte';
  import { provideRoomMediaPreviews, RoomMediaPreviews } from './room-media-previews.svelte.js';

  interface Props {
    item: TimelineItemView;
    joinRule: RoomJoinRuleView;
  }

  let { item, joinRule }: Props = $props();

  provideRoomMediaPreviews(new RoomMediaPreviews(() => joinRule));
</script>

<MessageBody {item} canRedactOthers={false} />
