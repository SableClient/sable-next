<script lang="ts">
  import '#lib/ui/primitives/menu.css';
  import MessageActions from '../messages/MessageActions.svelte';
  import MessageReactions from '../messages/MessageReactions.svelte';
  import { TimelineRow, type TimelineItemProps } from './timeline-row.svelte';
  import TimelineNotice from './TimelineNotice.svelte';
  import TimelineSwipeAction from './TimelineSwipeAction.svelte';

  let {
    item,
    unreadCount = 0,
    roomId = '',
    highlighted = false,
    onSenderProfile,
    currentUserId = null,
    onToggleReaction,
    onReply,
    onCancelContext,
    onOpenThread,
    onEdit,
    onDelete,
    onCopyLink,
    onMarkUnread,
    canRedactOwn = true,
    canRedactOthers = false,
    canPin = true,
    selected = false,
    editing = false,
    preview = false,
    loadPreviewProfile = false,
    members = [],
    onJumpToEvent,
    events,
    onMenuOpenChange,
    overrideCosmetics = null,
    onSwipeMembers,
  }: TimelineItemProps = $props();

  const row = new TimelineRow(() => ({
    item,
    roomId,
    canPin,
    canRedactOwn,
    canRedactOthers,
    preview,
    loadPreviewProfile,
    selected,
    editing,
    overrideCosmetics,
    replySender: null,
    hasLinkPreviews: item.link_previews_removed !== true && item.bundled_link_previews.length > 0,
    onToggleReaction,
    onMarkUnread,
    onReply,
    onCancelContext,
    onEdit,
    onDelete,
    onOpenThread,
    onCopyLink,
    onMenuOpenChange,
    onSwipeMembers,
  }));
</script>

<article
  class={['message', 'event-row', { highlighted }]}
  data-selected={selected ? 'true' : undefined}
  style:--sender-name-color={row.senderColors.nameColor}
  style:--name-color-on-light={row.senderColors.nameColorLight ?? undefined}
  style:--name-color-on-dark={row.senderColors.nameColorDark ?? undefined}
  style:transform={row.swipe.offset === 0
    ? undefined
    : `translateX(${String(-row.swipe.offset)}px)`}
  style:transition={row.swipe.dragging ? 'none' : undefined}
  onpointerdown={row.pointerDown}
  onpointermove={row.press.move}
  onpointerup={row.pointerUp}
  onpointercancel={row.pointerCancel}
  onpointerenter={row.engagement.engage}
  onpointerleave={row.engagement.disengage}
  onfocusin={row.engagement.engage}
  onfocusout={row.engagement.disengage}
  oncontextmenu={row.openContextMenu}
  {@attach row.attach}
>
  {#if row.swipe.offset > 0}
    <TimelineSwipeAction
      offset={row.swipe.offset}
      armed={row.swipe.action !== 'none'}
      members={row.swipeOpensMembers}
    />
  {/if}
  {#if row.showActions}
    <MessageActions
      onPickerOpenChange={row.pinActions}
      onOverflowOpenChange={row.pinActions}
      {...row.actions}
    />
  {/if}
  <TimelineNotice
    {item}
    {unreadCount}
    {roomId}
    {events}
    {members}
    {currentUserId}
    {onSenderProfile}
    {onJumpToEvent}
  />
  {#if item.reactions.length > 0}
    <div class="event-reactions">
      <span class="event-rail" aria-hidden="true"></span>
      <MessageReactions
        reactions={item.reactions}
        eventId={item.event_id}
        {currentUserId}
        {members}
        {roomId}
        actionable={row.actionable}
        onReact={row.actions.onReact}
        {onToggleReaction}
        onViewReactions={(index: number) => {
          row.dialogs.open(item, { kind: 'reactions', active: index });
        }}
      />
    </div>
  {/if}
</article>

<style>
  @media (pointer: coarse) {
    .message {
      touch-action: manipulation;
      -webkit-touch-callout: none;
      user-select: none;
    }

    .message :global(.formatted-body),
    .message :global(pre),
    .message :global(code) {
      user-select: none;
    }
  }

  .message {
    display: block;
    margin-inline: calc(-1 * var(--page-gutter));
    overflow-wrap: anywhere;
    padding: 0 var(--page-gutter);
    position: relative;
  }

  @media (any-pointer: fine) {
    .message {
      user-select: text;
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    .message {
      transition: transform var(--duration-fast) var(--ease-smooth-out);
    }
  }

  .event-reactions {
    display: flex;
    gap: var(--timeline-row-gap);
  }

  .event-rail {
    flex: 0 0 var(--avatar-size-small);
  }

  .message:focus-within :global(.message-actions) {
    opacity: 1;
    pointer-events: auto;
  }

  .message[data-selected='true'] {
    background: var(--surface-container-active);
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 var(--border-width) var(--surface-container-line);
  }

  .message:has(:focus-visible):not([data-selected='true']) {
    background: var(--bg-container-hover);
    border-radius: var(--radius);
    color: var(--bg-on-container);
  }

  .message.highlighted {
    --message-highlight-duration: 6s;

    border-radius: var(--radius);
  }

  @keyframes jump {
    0% {
      background-color: var(--primary-container);
      color: var(--primary-on-container);
    }

    16% {
      background-color: var(--primary-container-active);
      color: var(--primary-on-container);
    }

    33%,
    100% {
      background-color: transparent;
      color: inherit;
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .message.highlighted {
      animation: jump var(--message-highlight-duration) var(--motion-easing-standard);
    }
  }

  @keyframes jump-reduced {
    0% {
      background-color: var(--primary-container);
      color: var(--primary-on-container);
    }

    33%,
    100% {
      background-color: transparent;
      color: inherit;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .message.highlighted {
      animation: jump-reduced var(--message-highlight-duration) steps(1, end);
    }
  }

  :global(html[data-reduced-motion='on']) .message.highlighted {
    animation: jump-reduced var(--message-highlight-duration) steps(1, end);
  }

  @media (--app-layout) and (any-hover: hover) and (any-pointer: fine) {
    .message:hover {
      background-color: var(--surface-container-hover);
    }

    .message:hover :global(.message-actions) {
      opacity: 1;
      pointer-events: auto;
    }
  }
</style>
