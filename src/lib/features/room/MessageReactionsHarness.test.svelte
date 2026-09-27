<script lang="ts">
  import { untrack, type ComponentProps } from 'svelte';

  import type { RoomJoinRuleView } from '#src/generated/protocol';

  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  import MessageReactions from './MessageReactions.svelte';
  import { provideRoomMediaPreviews, RoomMediaPreviews } from './room-media-previews.svelte.js';

  let {
    joinRule,
    ...props
  }: ComponentProps<typeof MessageReactions> & { joinRule?: RoomJoinRuleView } = $props();

  if (untrack(() => joinRule))
    provideRoomMediaPreviews(new RoomMediaPreviews(() => joinRule ?? null));
</script>

<TooltipProvider>
  <MessageReactions {...props} />
</TooltipProvider>
