<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import MessageQuickReactions from './MessageQuickReactions.svelte';

  let props: ComponentProps<typeof MessageQuickReactions> = $props();
</script>

<MessageQuickReactions {...props} />
