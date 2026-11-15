<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import {
    OpenMessageMenu,
    provideMessageMenu,
  } from '#lib/features/room/messages/message-menu-open.svelte.js';
  import ForumThreadList from './ForumThreadList.svelte';

  let props: ComponentProps<typeof ForumThreadList> = $props();
  provideMessageMenu(new OpenMessageMenu());
</script>

<ForumThreadList {...props} />
