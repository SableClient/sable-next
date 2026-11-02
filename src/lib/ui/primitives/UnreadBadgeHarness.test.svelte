<script lang="ts">
  import UnreadBadge from './UnreadBadge.svelte';

  let unread = $state(0);
</script>

<button type="button" onclick={() => (unread = 3)}>Receive</button>
<UnreadBadge counts={{ unread, notifying: 0, highlight: 0, marked: false }} />
