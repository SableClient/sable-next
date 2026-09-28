<script lang="ts">
  import type { RoomJoinRuleView } from '#src/generated/protocol';

  import LinkPreviewCard from './LinkPreviewCard.svelte';
  import { provideMediaViewerOpener, type StandaloneMedia } from './media-viewer-opener.svelte.js';
  import { provideRoomMediaPreviews, RoomMediaPreviews } from './room-media-previews.svelte.js';

  interface Props {
    url: string;
    joinRule: RoomJoinRuleView;
    opener?: (item: StandaloneMedia) => void;
  }

  let { url, joinRule, opener = (): void => {} }: Props = $props();

  provideRoomMediaPreviews(new RoomMediaPreviews(() => joinRule));
  provideMediaViewerOpener((item) => opener(item));
</script>

<LinkPreviewCard {url} encrypted={false} />
