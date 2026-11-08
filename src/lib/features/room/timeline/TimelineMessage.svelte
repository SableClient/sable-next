<script lang="ts">
  import type { ReplyView } from '#src/generated/protocol';

  import '../members/avatar-button.css';
  import { mediaProgress } from '#lib/ui/media-progress.svelte.js';
  import { senderDisplayColors } from '../members/members.js';
  import { previewableLinks } from '../media/link-preview.js';
  import LinkEmbed from '../media/embeds/LinkEmbed.svelte';
  import { isMediaCaptionContent } from '../messages/media-caption.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Skeleton from '#lib/ui/primitives/Skeleton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { nameColorOnDark, nameColorOnLight } from '#lib/ui/primitives/readable-color.js';

  import FormattedBody from '../messages/FormattedBody.svelte';
  import MessageBody from '../messages/MessageBody.svelte';
  import MessageReactions from '../messages/MessageReactions.svelte';
  import MessageActions from '../messages/MessageActions.svelte';

  import '#lib/ui/primitives/menu.css';
  import ReadReceiptStack from './ReadReceiptStack.svelte';
  import { receiptReserve } from './receipt-reserve';
  import SenderName from '../members/SenderName.svelte';
  import RoleTagIcon from '../members/RoleTagIcon.svelte';
  import ForwardedLine from '../messages/ForwardedLine.svelte';
  import '../members/sender-identity.css';
  import { formatFullTimestamp, formatMessageTimestamp, formatTime } from '#lib/ui/date-time.js';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import { MessageSender } from './message-sender.svelte';
  import { TimelineRow, type TimelineItemProps } from './timeline-row.svelte';
  import TimelineReplyPreview from './TimelineReplyPreview.svelte';
  import TimelineSendFailure from './TimelineSendFailure.svelte';
  import TimelineSwipeAction from './TimelineSwipeAction.svelte';
  import TimelineThreadSummary from './TimelineThreadSummary.svelte';
  import TimelineTransfer from './TimelineTransfer.svelte';
  import UndecryptableNotice from './UndecryptableNotice.svelte';
  import MessageShieldNotice from './MessageCryptoStatus.svelte';

  let {
    item,
    collapsed,
    replyPersona = null,
    threadPersona = null,
    roomId = '',
    highlighted = false,
    onMatrixLink,
    onSenderProfile,
    onMentionUser,
    onRetrySend,
    onCancelSend,
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
    encrypted = null,
    selected = false,
    editing = false,
    editor,
    layout = 'modern',
    preview = false,
    loadPreviewProfile = false,
    timeAction,
    headerAction,
    alignOwn = true,
    avatarsInHeaders = true,
    members = [],
    onJumpToEvent,
    onOpenMedia,
    onVotePoll,
    onEndPoll,
    events,
    onMenuOpenChange,
    placeholder = false,
    placeholderCharacters = 35,
    overrideCosmetics = null,
    onSwipeMembers,
  }: TimelineItemProps = $props();

  const labelId = $props.id();
  const named = $derived(layout === 'compact' || !collapsed);

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
    replySender,
    hasLinkPreviews: bundledPreviews.length > 0 || previewUrls.length > 0,
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
    onCancelSend,
  }));

  let defaultEmoteSize = $derived(preferences.timelineEmoteSize === 'default');
  let timelineEmoteSize = $derived(defaultEmoteSize ? '1lh' : `${preferences.timelineEmoteSize}px`);
  const sender = new MessageSender(() => ({
    item,
    members,
    profile: row.profile,
    cosmetics: row.senderCosmetics,
    onSenderProfile,
    onMentionUser,
  }));
  let replyTarget = $derived(
    item.in_reply_to ? (events?.get(item.in_reply_to.event_id) ?? null) : null
  );
  let replySender = $derived(item.in_reply_to?.sender ?? replyTarget?.sender ?? null);
  let emote = $derived(item.content.kind === 'message' && item.content.msgtype === 'emote');
  let notice = $derived(item.content.kind === 'message' && item.content.msgtype === 'notice');
  let jumbo = $derived(item.content.kind === 'message' ? (item.content.jumbo ?? null) : null);
  let upload = $derived(
    item.send_state?.status === 'sending' ? (item.send_state.progress ?? null) : null
  );
  let uploading = $derived(
    row.pending &&
      (item.content.kind === 'image' ||
        item.content.kind === 'video' ||
        item.content.kind === 'audio' ||
        item.content.kind === 'file' ||
        item.content.kind === 'gallery')
  );
  let galleryCount = $derived(item.content.kind === 'gallery' ? item.content.items.length : 0);
  const saving = mediaProgress(row.core, () => row.actionExecutor.savingSource);
  let transfer = $derived.by(() => {
    const onCancel = item.transaction_id ? cancelSend : undefined;
    if (upload !== null) {
      const part = upload.total > 0 ? Math.min(1, upload.current / upload.total) : 0;
      const gallery = galleryCount > 1;
      return {
        label: i18n.t('timeline.uploading'),
        max: 1,
        value: gallery ? Math.min(1, (upload.index + part) / galleryCount) : part,
        count: gallery
          ? i18n.t('timeline.uploadingItem', {
              current: Math.min(upload.index + 1, galleryCount),
              count: galleryCount,
            })
          : null,
        onCancel,
      };
    }
    if (uploading) return { label: i18n.t('timeline.uploading'), onCancel };
    if (saving.percent !== null)
      return { label: i18n.t('timeline.downloading'), max: 100, value: saving.percent };
    if (row.actionExecutor.savingSlow) return { label: i18n.t('timeline.downloading') };
    return null;
  });

  let editable = $derived(
    !item.forwarded &&
      item.is_own &&
      (item.content.kind === 'message' || isMediaCaptionContent(item.content))
  );
  let emoteColors = $derived(
    item.forwarded ? senderDisplayColors(sender.emoteSender ?? '', null) : row.senderColors
  );
  let senderRoleIcon = $derived(row.senderRole?.icon ?? null);

  let threadSummary = $derived(item.thread_summary);
  let threadTarget = $derived(
    threadSummary ? (item.thread_root ?? item.event_id) : item.thread_root
  );
  let receiptReaders = $derived(item.read_by.filter((readerId) => readerId !== currentUserId));
  let showReceiptBadge = $derived(
    !preferences.hideReadReceipts &&
      preferences.readReceiptPlacement === 'message' &&
      receiptReaders.length > 0
  );
  let nonTextContent = $derived(item.content.kind !== 'message');
  let previewsRemoved = $derived(item.link_previews_removed === true);
  let bundledPreviews = $derived(previewsRemoved ? [] : item.bundled_link_previews);
  let previewUrls = $derived.by(() => {
    if (previewsRemoved || bundledPreviews.length > 0) return [];
    const content = item.content;
    if (content.kind === 'message' || content.kind === 'gallery')
      return previewableLinks(content.html, content.body);
    if (isMediaCaptionContent(content) && content.caption !== null)
      return previewableLinks(content.html ?? '', content.caption).filter(
        (url) => url !== content.external_url
      );
    return [];
  });
  let receiptWidth = $state(0);
  let receiptsInline = $derived(
    (!nonTextContent || item.content.kind === 'redacted') &&
      item.reactions.length === 0 &&
      !threadSummary &&
      !item.thread_root &&
      bundledPreviews.length === 0 &&
      previewUrls.length === 0 &&
      upload === null &&
      row.stalled === null
  );

  let receiptsVisible = $derived(showReceiptBadge && (row.actionable || preview));
  let trailingReceiptBadge = $derived(receiptsVisible && !receiptsInline);
  let inlineReceipts = $derived(receiptsVisible && receiptsInline);

  function cancelSend(): void {
    if (item.transaction_id) onCancelSend?.(item.transaction_id);
  }

  function openSenderProfile(event: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    sender.openProfile(event.currentTarget);
  }
</script>

{#snippet receiptSlot()}
  <span
    class="receipt-slot"
    bind:borderBoxSize={
      null, (box: ResizeObserverSize[]) => (receiptWidth = box[0]?.inlineSize ?? 0)
    }
  >
    <ReadReceiptStack
      readers={receiptReaders}
      timestamps={item.read_timestamps}
      {members}
      expanded={row.dialogs.isOpen(item, 'receipts')}
      onProfile={onSenderProfile}
      onOpen={() => {
        row.dialogs.open(item, { kind: 'receipts' });
      }}
    />
  </span>
{/snippet}

{#snippet inlineReceiptSlot()}
  {#if inlineReceipts}
    <span class="receipt-space" aria-hidden="true"></span>
    {@render receiptSlot()}
  {/if}
{/snippet}

{#snippet replyPreview(reply: ReplyView)}
  <TimelineReplyPreview
    {reply}
    target={replyTarget}
    sender={replySender}
    persona={replyPersona}
    profile={row.profiles.reply}
    {currentUserId}
    {members}
    {onJumpToEvent}
  />
{/snippet}

{#snippet senderAvatarButton(size: 'tiny' | 'small')}
  {#snippet avatar()}
    <Avatar
      class="message-avatar"
      src={sender.avatar}
      {size}
      id={sender.tint ? null : item.sender}
      name={sender.name}
    />
  {/snippet}
  {#if item.sender && onSenderProfile}
    <button
      class="avatar-button"
      type="button"
      aria-label={i18n.t('timeline.senderProfile', { name: sender.name })}
      onclick={openSenderProfile}
    >
      {@render avatar()}
    </button>
  {:else}
    {@render avatar()}
  {/if}
{/snippet}

{#snippet actions()}
  {#if row.showActions}
    <MessageActions
      onPickerOpenChange={row.pinActions}
      onOverflowOpenChange={row.pinActions}
      {...row.actions}
    />
  {/if}
  {#if !row.actionable && !row.canCancelSend && editable && item.transaction_id && row.engagement.engaged}
    <MessageActions {roomId} onEdit={row.actions.onEdit} />
  {/if}
{/snippet}

{#snippet messageTime(format: (timestamp: number) => string)}
  {#if row.pending}
    <Spinner small label={i18n.t('timeline.sending')} />
  {:else}
    <Tooltip>
      {#snippet content()}{formatFullTimestamp(item.timestamp)}{/snippet}
      {#snippet trigger({ props })}
        <time {...props} datetime={new Date(item.timestamp).toISOString()}>
          {format(item.timestamp)}
        </time>
      {/snippet}
    </Tooltip>
  {/if}
{/snippet}

{#if placeholder}
  <article
    class={['message', 'placeholder-message', `layout-${layout}`, { collapsed }]}
    aria-hidden="true"
  >
    {#if layout === 'compact'}
      <div class="compact-gutter">
        <time><Skeleton class="placeholder-time" /></time>
        <Skeleton class="compact-name placeholder-name" />
      </div>
    {:else if !collapsed}
      <Skeleton class="avatar-root avatar-small message-avatar placeholder-avatar" />
    {/if}
    <div class="message-content">
      {#if !collapsed && layout !== 'compact'}
        <header id={`${labelId}-head`}>
          <Skeleton class="sender placeholder-name" />
          <div class="message-details">
            <time><Skeleton class="placeholder-time" /></time>
          </div>
        </header>
      {/if}
      {#if placeholderCharacters > 0}
        <div class="formatted-body placeholder-body">
          <span class="placeholder-copy">{'x'.repeat(placeholderCharacters)}</span>
        </div>
      {/if}
    </div>
  </article>
{:else}
  <article
    class={[
      'message',
      `layout-${layout}`,
      {
        collapsed,
        highlighted,
        pressed: row.press.pressing,
        'has-connected-reply':
          item.in_reply_to !== null && preferences.replyPreviewStyle === 'connected',
        persona: sender.tint,
        own: item.is_own,
        'align-own': alignOwn,
        'mention-silent': preferences.highlightMentions && item.mention === 'silent',
        'mention-loud': preferences.highlightMentions && item.mention === 'loud',
        'menu-open': row.actionsPinned || row.menu.isOpen(item.id),
      },
    ]}
    data-selected={selected ? 'true' : undefined}
    aria-labelledby={named ? `${labelId}-head` : undefined}
    aria-describedby={`${labelId}-body`}
    style:--pmp-on-light={nameColorOnLight(sender.tint?.color_on_light) ?? undefined}
    style:--pmp-on-dark={nameColorOnDark(sender.tint?.color_on_dark) ?? undefined}
    style:--sender-name-color={row.senderColors.nameColor}
    style:--name-color-on-light={row.senderColors.nameColorLight ?? undefined}
    style:--name-color-on-dark={row.senderColors.nameColorDark ?? undefined}
    style:--timeline-emote-size={timelineEmoteSize}
    style:--timeline-emote-align={defaultEmoteSize ? 'bottom' : undefined}
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
        edit={row.swipe.action === 'edit'}
        members={row.swipeOpensMembers}
      />
    {/if}
    {#if layout !== 'compact' && !collapsed}
      {@render senderAvatarButton('small')}
      {@render actions()}
    {:else if layout !== 'compact' && row.pending}
      <span class="collapsed-pending">
        <Spinner small label={i18n.t('timeline.sending')} />
      </span>
    {:else if layout !== 'compact' && preferences.showAllTimestamps}
      <span class="collapsed-pending collapsed-time">{@render messageTime(formatTime)}</span>
    {/if}
    <div
      class="message-content"
      style:--receipt-reserve={trailingReceiptBadge ? `${String(receiptWidth)}px` : undefined}
    >
      {#if layout === 'compact'}
        <div class="compact-gutter" id={`${labelId}-head`}>
          {@render messageTime(formatTime)}
          <div class="compact-user">
            {#if avatarsInHeaders}
              {@render senderAvatarButton('tiny')}
            {/if}
            <SenderName
              displayName={sender.name}
              colors={row.senderColors}
              pronouns={sender.pronouns}
              nameClass="compact-name"
              onMention={sender.nameAction === 'mention' ? sender.mention : undefined}
              onProfile={sender.nameAction === 'profile' ? sender.openProfile : undefined}
              compact={layout === 'compact'}
            />
          </div>
        </div>
      {/if}
      {#if item.in_reply_to && (preferences.replyPreviewStyle === 'connected' || layout === 'compact')}
        {@render replyPreview(item.in_reply_to)}
      {/if}
      {#if !collapsed && layout !== 'compact'}
        <header>
          {#if !emote}
            <SenderName
              displayName={sender.name}
              accountName={sender.persona ? sender.accountName : undefined}
              colors={row.senderColors}
              pronouns={sender.pronouns}
              onMention={sender.nameAction === 'mention' ? sender.mention : undefined}
              onProfile={sender.nameAction === 'profile' ? sender.openProfile : undefined}
              onViaProfile={sender.openAccountProfile}
            />
            {#if senderRoleIcon}
              {#if preferences.showRoleTooltip && row.senderRole?.name}
                <Tooltip label={row.senderRole.name}>
                  {#snippet trigger({ props })}
                    <span {...props} class="sender-role"><RoleTagIcon icon={senderRoleIcon} /></span
                    >
                  {/snippet}
                </Tooltip>
              {:else}
                <RoleTagIcon icon={senderRoleIcon} />
              {/if}
            {/if}
          {/if}
          <div class="message-details">
            {#if item.sender}
              <button
                class="via via-hidden"
                type="button"
                aria-label={i18n.t('timeline.senderProfile', { name: item.sender })}
                onclick={openSenderProfile}>{item.sender}</button
              >
            {/if}
            {#if timeAction}
              <button
                class="message-time-action"
                type="button"
                aria-label={timeAction.label}
                onclick={timeAction.run}
              >
                {@render messageTime(formatMessageTimestamp)}
              </button>
            {:else}
              {@render messageTime(formatMessageTimestamp)}
            {/if}
            {@render headerAction?.()}
          </div>
        </header>
      {/if}
      <div class="message-main" id={`${labelId}-body`}>
        {#if layout === 'compact' || collapsed}
          {@render actions()}
        {/if}
        {#if item.in_reply_to && preferences.replyPreviewStyle !== 'connected' && layout !== 'compact'}
          {@render replyPreview(item.in_reply_to)}
        {/if}
        {#if item.forwarded && item.forwarded.content_valid !== false}
          <div>
            <ForwardedLine forwarded={item.forwarded} {roomId} {members} {onJumpToEvent} />
          </div>
        {/if}
        {#if item.content.kind === 'message' && item.content.msgtype === 'emote'}
          <div
            class={['emote', { 'has-receipts': inlineReceipts }]}
            style:--receipt-reserve={inlineReceipts ? `${String(receiptWidth)}px` : undefined}
            {@attach inlineReceipts ? receiptReserve : undefined}
          >
            * <SenderName
              displayName={sender.emoteName}
              colors={emoteColors}
              onMention={sender.emoteNameAction === 'mention' ? sender.mentionEmote : undefined}
              onProfile={sender.emoteNameAction === 'profile' ? sender.openEmoteProfile : undefined}
            />
            <FormattedBody
              html={item.content.html}
              senderTimezone={row.senderTimezone}
              {onMatrixLink}
            />
            {@render inlineReceiptSlot()}
          </div>
        {:else if item.content.kind === 'message' && editor}
          {@render editor()}
        {:else if item.content.kind === 'message'}
          <div
            class={[
              jumbo === null ? undefined : `jumbo jumbo-${String(jumbo)}`,
              { notice, 'has-edited': item.content.edited, 'has-receipts': inlineReceipts },
            ]}
            style:--receipt-reserve={inlineReceipts ? `${String(receiptWidth)}px` : undefined}
            {@attach inlineReceipts ? receiptReserve : undefined}
          >
            <FormattedBody
              html={item.content.html}
              senderTimezone={row.senderTimezone}
              {onMatrixLink}
            />
            <!-- After the body, where the edit happened. -->
            {#if item.content.edited}
              <span class="edited">{i18n.t('timeline.edited')}</span>
            {/if}
            {@render inlineReceiptSlot()}
          </div>
        {:else if item.content.kind === 'redacted'}
          <div
            class={{ 'content-bubble': layout === 'bubble', 'has-receipts': inlineReceipts }}
            style:--receipt-reserve={inlineReceipts ? `${String(receiptWidth)}px` : undefined}
            {@attach inlineReceipts ? receiptReserve : undefined}
          >
            <MessageBody
              {item}
              {canRedactOthers}
              redactionReason={item.event_id ? events?.redactionReason(item.event_id) : null}
              redactedBy={events?.redactor(item) ?? item.content.redacted_by ?? null}
            />
            {@render inlineReceiptSlot()}
          </div>
        {:else if item.content.kind === 'unable_to_decrypt'}
          <UndecryptableNotice
            cause={item.content.reason}
            userId={item.sender ?? ''}
            displayName={sender.name}
          />
        {:else}
          <div class={{ 'content-bubble': layout === 'bubble' && nonTextContent }}>
            <MessageBody
              {item}
              senderTimezone={row.senderTimezone}
              {members}
              {canRedactOthers}
              {encrypted}
              {onMatrixLink}
              {onOpenMedia}
              {onVotePoll}
              {onEndPoll}
              {onSenderProfile}
            />
          </div>
        {/if}
        {#if !editor}
          {#each bundledPreviews as preview (preview.url)}
            <LinkEmbed url={preview.url} bundled={preview} {encrypted} />
          {/each}
          {#each previewUrls as url (url)}
            <LinkEmbed {url} {encrypted} />
          {/each}
        {/if}
        {#if threadTarget && onOpenThread}
          {@const target = threadTarget}
          <TimelineThreadSummary
            summary={threadSummary}
            persona={threadPersona}
            onOpen={() => {
              onOpenThread(target);
            }}
          />
        {/if}
        {#if item.reactions.length > 0}
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
        {/if}
        {#if transfer}
          <TimelineTransfer {...transfer} />
        {/if}
        {#if row.stalled}
          <TimelineSendFailure
            failure={row.stalled}
            transactionId={item.transaction_id}
            {members}
            {onRetrySend}
            {onCancelSend}
          />
        {/if}
        {#if trailingReceiptBadge}
          <span class="receipt-tail" aria-hidden="true"></span>
        {/if}
      </div>
      {#if item.shield && (item.shield.critical || !preferences.hideMessageShields)}
        <MessageShieldNotice shield={item.shield} />
      {/if}
      {#if trailingReceiptBadge}
        {@render receiptSlot()}
      {/if}
    </div>
  </article>
{/if}

<style>
  .placeholder-message {
    pointer-events: none;
  }

  .placeholder-message :global(.skeleton) {
    background: color-mix(in srgb, var(--bg-on-container) 18%, var(--bg-container));
  }

  .placeholder-body {
    line-height: var(--line-height-body);
  }

  .placeholder-copy {
    background: color-mix(in srgb, var(--bg-on-container) 18%, var(--bg-container));
    border-radius: var(--radius);
    box-decoration-break: clone;
    color: transparent;
    overflow-wrap: anywhere;
    user-select: none;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .placeholder-copy {
      animation: skeleton-pulse 1.8s ease-in-out infinite;
    }
  }

  :global(.skeleton.placeholder-avatar) {
    background: color-mix(in srgb, var(--bg-on-container) 24%, var(--bg-container));
    border-radius: var(--radii-400);
  }

  :global(.skeleton.placeholder-name) {
    height: var(--font-size-body);
    width: 6.5rem;
  }

  :global(.skeleton.placeholder-time) {
    height: var(--font-size-small);
    width: 3rem;
  }

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
    display: flex;
    gap: var(--timeline-row-gap);
    margin-inline: calc(-1 * var(--page-gutter));
    overflow-wrap: anywhere;
    padding: var(--timeline-row-padding) var(--page-gutter);
    position: relative;
  }

  @media (any-pointer: fine) {
    .message {
      user-select: text;
    }
  }

  .message:not(.layout-compact) > :global(.avatar-button),
  .message:not(.layout-compact) > :global(.avatar-root.message-avatar) {
    translate: 0 var(--space-100);
  }

  @media (prefers-reduced-motion: no-preference) {
    .message {
      transition: transform var(--duration-fast) var(--ease-smooth-out);
    }
  }

  .message:focus-within :global(.message-actions) {
    opacity: 1;
    pointer-events: auto;
  }

  .message.mention-silent,
  .message.mention-loud {
    --mention-gutter: calc(var(--space-200) + var(--border-width) * 4);

    border-inline-start: calc(var(--border-width) * 4) solid;
    border-radius: 0 var(--radius) var(--radius) 0;
    margin-inline: calc(-1 * var(--mention-gutter)) calc(-1 * var(--space-200));
    padding-inline: var(--space-200);
  }

  .message.mention-silent {
    background: color-mix(in srgb, var(--sec-container) 25%, transparent);
    border-inline-start-color: var(--sec-container-line);
  }

  .message.mention-loud {
    background: color-mix(in srgb, var(--warn-container) 25%, transparent);
    border-inline-start-color: var(--warn-container-line);
  }

  /* The sheet pairs multi-select with keyboard focus; focus is the half that
     exists today, and it survives on touch where hover does not. */
  .message[data-selected='true'] {
    background: var(--surface-container-active);
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 var(--border-width) var(--surface-container-line);
  }

  .message:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-offset));
  }

  .message:has(:focus-visible):not([data-selected='true'], :has(.reply-preview:focus-visible)) {
    background: var(--bg-container-hover);
    border-radius: var(--radius);
    color: var(--bg-on-container);
  }

  .message.collapsed {
    padding-left: calc(var(--page-gutter) + var(--avatar-size-small) + var(--timeline-row-gap));
    padding-top: 0;
  }

  .message.collapsed.mention-silent,
  .message.collapsed.mention-loud {
    padding-left: calc(var(--avatar-size-small) + var(--timeline-row-gap) + var(--space-200));
  }

  .collapsed-pending {
    display: flex;
    inset-block-start: 0;
    inset-inline-start: var(--page-gutter);
    justify-content: center;
    position: absolute;
    width: var(--avatar-size-small);
  }

  .collapsed-time {
    align-items: center;
    color: var(--surface-var-on-container);
    font-size: var(--font-size-x-small);
    font-variant-numeric: tabular-nums;
    height: calc(var(--font-size-editor) * var(--line-height-body));
    inset-inline-start: 0;
    justify-content: flex-end;
    white-space: nowrap;
    width: calc(
      var(--page-gutter) + var(--avatar-size-small) + var(--timeline-row-gap) - var(--space-100)
    );
  }

  .message.collapsed.mention-silent > .collapsed-pending,
  .message.collapsed.mention-loud > .collapsed-pending {
    inset-inline-start: var(--space-200);
  }

  .message.collapsed :global(.message-actions) {
    inset-inline-end: 0;
  }

  .message.layout-bubble.own.align-own > .collapsed-pending {
    inset-inline: auto var(--page-gutter);
  }

  .message.highlighted {
    --message-highlight-duration: 6s;
  }

  .message.highlighted:not(.mention-silent, .mention-loud) {
    border-radius: var(--radius);
  }

  .message.pressed {
    background: var(--bg-container-active);
    border-radius: var(--radius);
    color: var(--bg-on-container);
  }

  /* Glyph sizes for emoji-only messages, deliberately off the type scale. */
  .jumbo {
    --jumbo-size-1: 3rem;
    --jumbo-size-2: 2.4rem;
    --jumbo-size-3: 1.9rem;
    --jumbo-size-4: 1.55rem;
  }

  .jumbo :global([data-emoji]) {
    font-size: inherit;
    line-height: inherit;
    vertical-align: baseline;
  }

  .jumbo :global(.formatted-body img) {
    height: 1em;
    vertical-align: middle;
  }

  .jumbo-1 {
    font-size: var(--jumbo-size-1);
    line-height: 1.15;
  }

  .jumbo-2 {
    font-size: var(--jumbo-size-2);
    line-height: 1.2;
  }

  .jumbo-3 {
    font-size: var(--jumbo-size-3);
    line-height: 1.3;
  }

  .jumbo-4 {
    font-size: var(--jumbo-size-4);
    line-height: 1.35;
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
    /* Matches the base mention rule's specificity, so the gutter the row's
       negative margin assumes survives. */
    .message.mention-silent,
    .message.mention-loud {
      margin-inline: calc(-1 * var(--page-gutter));
      padding-inline: calc(var(--page-gutter) - var(--space-100)) var(--page-gutter);
    }

    /* The rule above resets the whole shorthand, and a collapsed row still
       owes the avatar gutter. */
    .message.collapsed.mention-silent,
    .message.collapsed.mention-loud {
      padding-left: calc(
        var(--page-gutter) - var(--space-100) + var(--avatar-size-small) + var(--timeline-row-gap)
      );
    }

    .message:hover,
    .message.menu-open {
      background-color: var(--surface-container-hover);
    }

    .message:hover :global(.message-actions) {
      opacity: 1;
      pointer-events: auto;
    }

    .message:hover :global(.via-hidden) {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .message-content {
    display: grid;
    flex: 1;
    grid-template-columns: minmax(0, 1fr) auto;
    min-width: 0;
    position: relative;
  }

  .message-content > header {
    grid-column: 1 / -1;
  }

  .message-main {
    font-size: var(--font-size-editor);
    grid-column: 1;
    min-width: 0;
    position: relative;
  }

  .receipt-slot {
    display: flex;
    user-select: none;
  }

  .message-content > .receipt-slot {
    inset-block-end: 0;
    inset-inline-end: 0;
    position: absolute;
  }

  .has-receipts :global(.formatted-body) {
    display: inline;
  }

  .has-receipts :global(.formatted-body > p:only-child) {
    display: inline;
  }

  .has-receipts .receipt-slot {
    inset-block-end: 0;
    inset-inline-end: 0;
    position: absolute;
  }

  .receipt-space {
    display: inline-block;
    inline-size: var(--receipt-reserve);
    user-select: none;
  }

  .has-receipts:global([data-receipt-narrow]) {
    padding-inline-end: calc(var(--receipt-reserve) + var(--space-200));
  }

  .has-receipts:global([data-receipt-narrow]) .receipt-space {
    display: none;
  }

  .message header {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    min-width: 0;
  }

  .sender-role {
    display: inline-flex;
  }

  .message header :global(.sender-identity) {
    flex-shrink: 1;
  }

  .message header .message-details {
    align-items: center;
    display: flex;
    flex-grow: 1;
    flex-shrink: 0;
    font-size: var(--font-size-small);
    justify-content: end;
    min-width: 0;
  }

  .persona {
    --ink-on-light: var(--pmp-on-light, var(--sec-on-container));
    --ink-on-dark: var(--pmp-on-dark, var(--sec-on-container));
    --pmp-ink: var(--ink);
  }

  .message.persona :global(.message-avatar) {
    color: var(--pmp-ink);
  }

  .message.persona :global(.message-avatar .avatar-fallback) {
    background: color-mix(in oklab, var(--pmp-ink) 18%, var(--surface-var-container));
  }

  .via {
    background: none;
    border: none;
    cursor: pointer;
    flex-grow: 1;
    letter-spacing: 0.01em;
    max-width: max-content;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 0;
  }

  .via.via-hidden {
    display: none;
  }

  @media (--app-layout) {
    .via.via-hidden {
      display: revert;
      opacity: 0;
    }
  }

  .via:hover {
    text-decoration: underline;
  }

  .emote {
    color: var(--success-main);
    font-style: italic;
    line-height: var(--line-height-body);
  }

  .emote .sender {
    font-style: normal;
  }

  .message.persona .sender {
    color: var(--pmp-ink);
  }

  .emote :global(.formatted-body) {
    display: inline;
  }

  .has-edited {
    line-height: var(--line-height-body);
  }

  .has-edited :global(.formatted-body) {
    display: inline;
  }

  time,
  .edited {
    color: var(--surface-var-on-container);
  }

  .message-details time {
    flex-shrink: 0;
  }

  .message-time-action {
    background: none;
    border: 0;
    cursor: pointer;
    flex: none;
    font: inherit;
    padding: 0;
    white-space: nowrap;
  }

  .message-time-action:hover {
    text-decoration: underline;
  }

  .edited {
    font-size: var(--font-size-small);
    margin-inline-start: var(--space-100);
  }

  /* `m.notice` is usually a bot, and reads as an aside. */
  .notice {
    color: light-dark(
      color-mix(var(--surface-var-on-container), var(--primary-main) 70%),
      var(--surface-var-on-container)
    );
  }

  .message.has-connected-reply:not(.layout-compact) > :global(.avatar-button),
  .message.has-connected-reply:not(.layout-compact) > :global(.avatar-root.message-avatar) {
    margin-top: var(--space-600);
  }

  @media (prefers-reduced-motion: no-preference) {
    .via {
      transition: background-color var(--motion-fast) var(--motion-easing-standard);
    }

    .via-hidden {
      transition: opacity var(--motion-fast) var(--motion-easing-standard);
    }
  }

  .message.mention-loud :global(a[data-matrix-link]) {
    background: var(--warn-container-active);
    border-color: var(--warn-container-line);
    color: var(--warn-on-container);
  }

  /* Layout modes stay in one block at the end: each overrides a base rule
     above, and a second copy elsewhere would drift out of sync. */
  .message.layout-compact .message-content {
    grid-template-columns: clamp(7.5rem, 20%, 10.625rem) minmax(0, 1fr) auto;
  }

  .message.layout-compact .message-content > :global(.reply-preview) {
    grid-column: 2;
    grid-row: 1;
  }

  .message.layout-compact .message-main {
    grid-column: 2;
    grid-row: 2;
  }

  .message.layout-compact :global(.message-crypto-status) {
    grid-column: 3;
    grid-row: 2;
  }

  .message.layout-compact :global(.message-actions) {
    inset-inline-end: 0;
  }

  .message.layout-compact.collapsed {
    padding-inline: var(--page-gutter);
  }

  .compact-gutter {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    grid-column: 1;
    grid-row: 2;
    height: fit-content;
    justify-content: space-between;
    margin-inline-end: var(--space-300);
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .message.has-connected-reply .compact-gutter {
    grid-row: 1;
  }

  .message.layout-compact .compact-gutter time {
    color: var(--surface-var-on-container);
    flex: none;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }

  .compact-user {
    display: flex;
    font-size: inherit;
    gap: var(--space-100);
  }

  .message.layout-bubble .message-main {
    align-items: flex-start;
    display: flex;
    flex-direction: column;
  }

  .message.layout-bubble .message-main > *,
  .message.layout-bubble
    .message-main
    > :global(:where(.reply-preview, .thread-summary, .transfer, .send-failure)) {
    max-width: min(50rem, 100%);
    min-width: 0;
  }

  .message.layout-bubble .content-bubble,
  .message.layout-bubble :global(.formatted-body) {
    background: var(--surface-var-container);
    border: var(--border-width) solid transparent;
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    max-width: min(50rem, 100%);
    padding: var(--space-200) var(--space-300);
  }

  .message.layout-bubble .content-bubble :global(.formatted-body) {
    background: none;
    border: 0;
    padding: 0;
  }

  .message.layout-bubble .content-bubble :global(.image) {
    margin-top: 0;
  }

  .message.layout-bubble .content-bubble {
    width: var(--timeline-bubble-width);
  }

  .message.layout-bubble .has-edited :global(.formatted-body) {
    display: inline-block;
  }

  .message.layout-bubble .has-receipts {
    padding-inline-end: calc(var(--receipt-reserve) + var(--space-200));
  }

  .message.layout-bubble .has-receipts:not(.content-bubble) {
    max-width: min(100%, calc(50rem + var(--receipt-reserve) + var(--space-200)));
  }

  .message.layout-bubble .has-receipts :global(.formatted-body) {
    display: inline-block;
  }

  .message.layout-bubble .receipt-space,
  .message.layout-bubble .receipt-tail {
    display: none;
  }

  .message:not(.layout-bubble) .message-main:has(> .receipt-tail) {
    align-items: flex-end;
    display: flex;
    flex-wrap: wrap;
  }

  .message:not(.layout-bubble) .message-main:has(> .receipt-tail) > *,
  .message:not(.layout-bubble)
    .message-main:has(> .receipt-tail)
    > :global(:where(.reply-preview, .thread-summary, .transfer, .send-failure)) {
    flex: 0 0 100%;
    min-width: 0;
  }

  .message:not(.layout-bubble) .message-main:has(> .receipt-tail) > :nth-last-child(2),
  .message:not(.layout-bubble)
    .message-main:has(> .receipt-tail)
    > :global(:where(.reply-preview, .thread-summary, .transfer, .send-failure)):nth-last-child(2) {
    flex: 0 1 auto;
  }

  .message:not(.layout-bubble.own.align-own)
    .message-main:has(> .receipt-tail)
    > :global(.reactions):nth-last-child(2),
  .message:not(.layout-bubble)
    .message-main:has(> .receipt-tail)
    > :nth-last-child(2):has(:global(.media-frame-audio, .poll, .location)) {
    flex-basis: calc(100% - var(--receipt-reserve) - var(--space-200));
    max-width: calc(100% - var(--receipt-reserve) - var(--space-200));
  }

  .message:not(.layout-bubble) .message-main > .receipt-tail {
    block-size: var(--size-x300);
    flex: none;
    inline-size: calc(var(--receipt-reserve) + var(--space-200));
    margin-inline-start: auto;
    user-select: none;
  }

  .message.layout-bubble:not(.own.align-own)
    .message-main:has(> .receipt-tail)
    > :nth-last-child(2),
  .message.layout-bubble:not(.own.align-own)
    .message-main:has(> .receipt-tail)
    > :global(:where(.reply-preview, .thread-summary, .transfer, .send-failure)):nth-last-child(2) {
    margin-inline-end: calc(var(--receipt-reserve) + var(--space-200));
  }

  .message.layout-bubble.own.align-own
    .message-main:has(> .receipt-tail)
    > :global(*):nth-last-child(2) {
    margin-inline-end: max(
      calc(var(--space-100) * 0),
      calc(var(--receipt-reserve) + var(--space-200) - var(--avatar-size-small) - var(--space-250))
    );
  }

  .message.layout-bubble.own.align-own .has-edited {
    align-items: flex-end;
    display: flex;
    flex-direction: row-reverse;
    gap: var(--space-100);
  }

  .message.layout-bubble.own.align-own .has-edited .edited {
    margin-inline-start: 0;
  }

  /* The one mode where your own side changes. */
  .message.layout-bubble.own.align-own {
    flex-direction: row-reverse;
  }

  .message.layout-bubble.own.align-own .message-main {
    align-items: flex-end;
    grid-column: 1 / -1;
  }

  .message.layout-bubble.own.align-own header {
    flex-direction: row-reverse;
  }

  .message.layout-bubble.own.align-own.collapsed {
    padding-left: 0;
    padding-right: calc(var(--avatar-size-small) + var(--space-250));
  }

  .message.layout-bubble.own.align-own .message-content > .receipt-slot {
    margin-inline-end: calc(-1 * (var(--avatar-size-small) + var(--timeline-row-gap)));
  }

  .message.layout-bubble.own.align-own.collapsed .message-content > .receipt-slot {
    margin-inline-end: calc(-1 * (var(--avatar-size-small) + var(--space-250)));
  }

  @supports not (color: color-mix(in srgb, black, white)) {
    .placeholder-message :global(.skeleton),
    .placeholder-copy,
    :global(.skeleton.placeholder-avatar) {
      background: var(--bg-container-hover);
    }

    .message.mention-silent {
      background: var(--sec-container);
    }

    .message.mention-loud {
      background: var(--warn-container);
    }

    .message.persona :global(.message-avatar .avatar-fallback) {
      background: var(--surface-container);
    }

    .notice {
      color: var(--surface-var-on-container);
    }
  }
</style>
