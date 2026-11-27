<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

  import { i18n } from '#lib/i18n.js';
  import '#lib/ui/primitives/menu.css';
  import './timeline-highlight.css';
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
    linkPreviews: [],
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
  class={[
    'message',
    'event-row',
    { highlighted, selecting: row.selecting, 'multi-selected': row.multiSelected },
  ]}
  data-selected={selected ? 'true' : undefined}
  data-multi-selected={row.multiSelected ? 'true' : undefined}
  style:--sender-name-color={row.senderColors.nameColor}
  style:--name-color-on-light={row.senderColors.nameColorLight ?? undefined}
  style:--name-color-on-dark={row.senderColors.nameColorDark ?? undefined}
  style:transform={row.swipe.offset === 0
    ? undefined
    : `translateX(calc(${String(-row.swipe.offset)}px * var(--inline-sign)))`}
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
  {#if row.selecting && row.actionable}
    <button
      type="button"
      class={['select-toggle', { checked: row.multiSelected }]}
      role="checkbox"
      aria-checked={row.multiSelected}
      aria-label={i18n.t(row.multiSelected ? 'timeline.deselectEvent' : 'timeline.selectEvent')}
    >
      <span class="select-box" aria-hidden="true">
        {#if row.multiSelected}<CheckIcon weight="bold" />{/if}
      </span>
    </button>
  {/if}
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
        onViewReactions={(key: string) => {
          row.dialogs.open(item, { kind: 'reactions', active: key });
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
    padding: 0 var(--page-gutter) 0 calc(var(--page-gutter) + var(--selection-gutter));
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

  .message:has(:focus-visible):not([data-selected='true'], [data-multi-selected='true']) {
    background: var(--bg-container-hover);
    border-radius: var(--radius);
    color: var(--bg-on-container);
  }

  .message.highlighted {
    border-radius: var(--radius);
  }

  @media (hover: hover) and (pointer: fine) {
    .message:hover {
      backdrop-filter: var(--message-hover-backdrop, none);
      background-color: var(--message-hover-container, var(--surface-container-hover));
    }

    .message:hover :global(.message-actions) {
      opacity: 1;
      pointer-events: auto;
    }
  }
</style>
