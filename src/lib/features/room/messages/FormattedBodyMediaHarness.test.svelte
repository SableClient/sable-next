<script lang="ts">
  import type { RoomJoinRuleView } from '#src/generated/protocol';

  import FormattedBody from './FormattedBody.svelte';
  import {
    provideRoomMediaPreviews,
    RoomMediaPreviews,
  } from '../media/room-media-previews.svelte.js';

  interface Props {
    html: string;
    joinRule: RoomJoinRuleView;
  }

  let { html, joinRule }: Props = $props();

  provideRoomMediaPreviews(new RoomMediaPreviews(() => joinRule));
</script>

<FormattedBody {html} />
