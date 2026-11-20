<script lang="ts">
  import { untrack, type ComponentProps } from 'svelte';

  import { provideRecentReactions, type RecentReactions } from '#lib/emoji/recents.svelte.js';

  import MessageQuickReactions from './MessageQuickReactions.svelte';

  let {
    history,
    ...props
  }: ComponentProps<typeof MessageQuickReactions> & { history?: RecentReactions } = $props();
  const shared = untrack(() => history);
  if (shared) provideRecentReactions(shared);
</script>

<MessageQuickReactions {...props} />
