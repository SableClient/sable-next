<script lang="ts">
  import { untrack, type ComponentProps } from 'svelte';

  import type { RoomJoinRuleView } from '#src/generated/protocol';

  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  import MessageReactions from './MessageReactions.svelte';
  import {
    provideRoomMediaPreviews,
    RoomMediaPreviews,
  } from '../media/room-media-previews.svelte.js';

  let {
    joinRule,
    onMessageContextMenu,
    ...props
  }: ComponentProps<typeof MessageReactions> & {
    joinRule?: RoomJoinRuleView;
    onMessageContextMenu?: (event: MouseEvent) => void;
  } = $props();

  if (untrack(() => joinRule))
    provideRoomMediaPreviews(new RoomMediaPreviews(() => joinRule ?? null));
</script>

<TooltipProvider>
  <div role="presentation" oncontextmenu={onMessageContextMenu}>
    <MessageReactions {...props} />
  </div>
</TooltipProvider>
