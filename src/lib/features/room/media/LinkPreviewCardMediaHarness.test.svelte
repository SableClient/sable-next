<script lang="ts">
  import type { RoomJoinRuleView } from '#src/generated/protocol';

  import LinkPreviewCard from './LinkPreviewCard.svelte';
  import { provideRoomMediaPreviews, RoomMediaPreviews } from './room-media-previews.svelte.js';

  interface Props {
    url: string;
    joinRule: RoomJoinRuleView;
  }

  let { url, joinRule }: Props = $props();

  provideRoomMediaPreviews(new RoomMediaPreviews(() => joinRule));
</script>

<LinkPreviewCard {url} encrypted={false} />
