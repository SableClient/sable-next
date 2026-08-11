<script lang="ts">
  import { page } from '$app/state';

  import RoomView from './RoomView.svelte';

  interface Props {
    focusEvent?: boolean;
  }

  let { focusEvent = false }: Props = $props();
</script>

<RoomView
  roomId={page.params.roomId ?? ''}
  eventId={focusEvent ? (page.params.eventId ?? null) : null}
/>
