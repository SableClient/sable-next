<script lang="ts">
  import { untrack, type Snippet } from 'svelte';

  import { provideRoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';

  import { MessageDialogs, provideMessageDialogs } from './message-dialogs.svelte.js';
  import { OpenMessageMenu, provideMessageMenu } from './message-menu-open.svelte.js';
  import { useRoomScopes } from './message-scope.svelte.js';
  import { providePinnedEvents } from './pinned-events.svelte.js';

  interface Props {
    roomId: string;
    children: Snippet;
  }

  let { roomId, children }: Props = $props();

  const scope = useRoomScopes().for(untrack(() => roomId));
  provideRoomCosmetics(scope.cosmetics);
  providePinnedEvents(scope.pinned);
  provideMessageDialogs(new MessageDialogs());
  provideMessageMenu(new OpenMessageMenu());
</script>

{@render children()}
