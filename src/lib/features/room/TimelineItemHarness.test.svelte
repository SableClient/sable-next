<script lang="ts">
  import { untrack, type ComponentProps } from 'svelte';

  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  import { Bookmarks, provideBookmarks, type BookmarkCommands } from './bookmarks.svelte.js';
  import {
    PinnedEvents,
    providePinnedEvents,
    type PinnedEventCommands,
  } from './pinned-events.svelte.js';
  import MessageContextMenu from './MessageContextMenu.svelte';
  import { OpenMessageMenu, provideMessageMenu } from './message-menu-open.svelte.js';
  import MessageDialogHost from './MessageDialogHost.svelte';
  import { MessageDialogs, provideMessageDialogs } from './message-dialogs.svelte.js';
  import TimelineItem from './TimelineItem.svelte';

  interface Props {
    core: PinnedEventCommands & BookmarkCommands;
    item: ComponentProps<typeof TimelineItem>;
    readers?: readonly string[];
    showItem?: boolean;
  }

  let { core, item, readers, showItem = true }: Props = $props();

  providePinnedEvents(new PinnedEvents(untrack(() => core)));
  provideBookmarks(new Bookmarks(untrack(() => core)));
  const dialogs = provideMessageDialogs(new MessageDialogs());
  const messageMenu = provideMessageMenu(new OpenMessageMenu());
  let events = $derived({
    get: (eventId: string) => (item.item.event_id === eventId ? item.item : null),
  });
</script>

<TooltipProvider>
  {#if showItem}
    <TimelineItem {...item} />
  {/if}
  <MessageContextMenu menu={messageMenu} />
  <MessageDialogHost
    {dialogs}
    {events}
    roomId={item.roomId}
    members={item.members}
    currentUserId={item.currentUserId}
    readers={readers ? () => readers : undefined}
    canRedactOwn={item.canRedactOwn}
    canRedactOthers={item.canRedactOthers}
    onMatrixLink={item.onMatrixLink}
    onSenderProfile={item.onSenderProfile}
    onToggleReaction={item.onToggleReaction}
    onReply={item.onReply}
    onOpenThread={item.onOpenThread}
    onDelete={item.onDelete}
  />
</TooltipProvider>
