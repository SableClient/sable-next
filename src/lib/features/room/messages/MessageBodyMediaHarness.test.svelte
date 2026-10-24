<script lang="ts">
  import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
  import type { RoomJoinRuleView } from '#src/generated/protocol';
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  import MessageBody from './MessageBody.svelte';
  import {
    provideRoomMediaPreviews,
    RoomMediaPreviews,
  } from '../media/room-media-previews.svelte.js';

  interface Props {
    item: ResolvedItem;
    joinRule: RoomJoinRuleView;
    onOpenMedia?: (eventId: string) => void;
  }

  let { item, joinRule, onOpenMedia }: Props = $props();

  provideRoomMediaPreviews(new RoomMediaPreviews(() => joinRule));
</script>

<TooltipProvider>
  <MessageBody {item} {onOpenMedia} canRedactOthers={false} />
</TooltipProvider>
