<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import MessageContextMenu from '#lib/features/room/messages/MessageContextMenu.svelte';
  import {
    OpenMessageMenu,
    provideMessageMenu,
  } from '#lib/features/room/messages/message-menu-open.svelte.js';
  import ForumThreadList from './ForumThreadList.svelte';

  let props: ComponentProps<typeof ForumThreadList> = $props();
  const menu = provideMessageMenu(new OpenMessageMenu());
</script>

<ForumThreadList {...props} />
<MessageContextMenu {menu} />
