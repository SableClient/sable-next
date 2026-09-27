<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import MessageContextMenu from '#lib/features/room/messages/MessageContextMenu.svelte';
  import {
    OpenMessageMenu,
    provideMessageMenu,
  } from '#lib/features/room/messages/message-menu-open.svelte.js';

  import ForumThreadItem from './ForumThreadItem.svelte';

  let props: ComponentProps<typeof ForumThreadItem> = $props();

  const menu = provideMessageMenu(new OpenMessageMenu());
</script>

<ForumThreadItem {...props} />
<MessageContextMenu {menu} />
