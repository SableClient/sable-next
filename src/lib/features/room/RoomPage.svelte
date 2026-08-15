<script lang="ts">
  import { page } from '$app/state';

  import RoomView from './RoomView.svelte';

  let eventId = $derived(page.url.searchParams.get('event'));
</script>

<RoomView roomId={page.params.roomId ?? ''} {eventId} />
