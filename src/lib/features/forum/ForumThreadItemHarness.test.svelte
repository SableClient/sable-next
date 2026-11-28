<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import { useCoreClient } from '#lib/core/context.js';
  import { provideRecentReactions, RecentReactions } from '#lib/emoji/recents.svelte.js';
  import MessageContextMenu from '#lib/features/room/messages/MessageContextMenu.svelte';
  import {
    OpenMessageMenu,
    provideMessageMenu,
  } from '#lib/features/room/messages/message-menu-open.svelte.js';

  import ForumThreadItem from './ForumThreadItem.svelte';

  let props: ComponentProps<typeof ForumThreadItem> = $props();

  provideRecentReactions(new RecentReactions(useCoreClient()));
  const menu = provideMessageMenu(new OpenMessageMenu());
</script>

<ForumThreadItem {...props} />
<MessageContextMenu {menu} />
