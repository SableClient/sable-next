<script lang="ts">
  import { onDestroy } from 'svelte';

  import type { MemberView } from '#src/generated/MemberView';
  import type { MessageKind } from '#src/generated/MessageKind';
  import type { PerMessageProfileView } from '#src/generated/PerMessageProfileView';
  import type { PersonaView } from '#src/generated/PersonaView';
  import type { ProfileView } from '#src/generated/ProfileView';
  import type { TimelineItemView } from '#src/generated/TimelineItemView';

  import { useCoreClient } from '#lib/core/context.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { LongPress } from './long-press.svelte.js';
  import {
    findMember,
    personaWithColor,
    senderDisplayColors,
    stripReplyFallback,
  } from './members.js';
  import { firstPreviewableLink } from './link-preview.js';
  import LinkPreviewCard from './LinkPreviewCard.svelte';
  import { MessageSwipe } from './message-swipe.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { projectPersona } from '#lib/personas/persona.js';
  import { pronounPillLimit, visiblePronouns } from '#lib/personas/pronouns.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { preferences, type TimelineLayout } from '#lib/settings/preferences.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Skeleton from '#lib/ui/primitives/Skeleton.svelte';
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';

  import FormattedBody from './FormattedBody.svelte';
  import MessageBody from './MessageBody.svelte';
  import MessageReactions from './MessageReactions.svelte';
  import { usePinnedEvents } from './pinned-events.svelte.js';
  import TimelineNotice from './TimelineNotice.svelte';
  import MessageActions from './MessageActions.svelte';
  import MessageActionSheet from './MessageActionSheet.svelte';

  import MessageForwardDialog from './MessageForwardDialog.svelte';
  import MessageReportDialog from './MessageReportDialog.svelte';
  import MessageSourceDialog from './MessageSourceDialog.svelte';
  import ReactionSheet from './ReactionSheet.svelte';
  import ThreadIcon from 'phosphor-svelte/lib/ChatCircleDotsIcon';
  import { useBookmarks } from './bookmarks.svelte.js';
  import { openMessageMenu } from './message-menu-open.svelte.js';
  import '#lib/ui/primitives/menu.css';
  import PersonaProfile from './PersonaProfile.svelte';
  import ReactionsDialog from './ReactionsDialog.svelte';
  import ReadReceiptStack from './ReadReceiptStack.svelte';
  import ReceiptsDialog from './ReceiptsDialog.svelte';
  import SenderName from './SenderName.svelte';
  import DeleteMessageDialog from './DeleteMessageDialog.svelte';
  import MessageReproxyDialog from './MessageReproxyDialog.svelte';
  import type { MatrixLink } from './matrix-link';
  import './sender-identity.css';
  import {
    formatMessageTimestamp,
    canRedact,
    isMessageRow,
    jumboEmojiLevel,
    senderColor,
  } from './timeline-format';

  interface Props {
    item: TimelineItemView;
    collapsed: boolean;
    unreadCount?: number;
    replyPersona?: PerMessageProfileView | null;
    roomId?: string;
    highlighted?: boolean;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
    onMentionUser?: (userId: string, name: string) => void;
    onRetrySend?: (transactionId: string) => void;
    onCancelSend?: (transactionId: string) => void;
    currentUserId?: string | null;
    onToggleReaction?: (eventId: string, key: string) => void;
    onReply?: (eventId: string) => void;
    onOpenThread?: (rootEventId: string) => void;
    onEdit?: (
      eventId: string,
      body: string,
      html: string | null,
      image?: {
        source: string;
        filename: string | null;
        mime: string | null;
        width: number | null;
        height: number | null;
      }
    ) => void;
    onDelete?: (eventId: string, reason: string | null) => void;
    onCopyLink?: (eventId: string) => void;
    onMarkUnread?: (eventId: string) => void;
    canRedactOthers?: boolean;
    selected?: boolean;
    layout?: TimelineLayout;
    members?: readonly MemberView[];
    onJumpToEvent?: (eventId: string) => void;
    onOpenMedia?: (eventId: string) => void;
    onVotePoll?: (eventId: string, answers: string[]) => void;
    onEndPoll?: (eventId: string) => void;
    onPersonaOpenChange?: (open: boolean) => void;
    placeholder?: boolean;
    placeholderCharacters?: number;
  }

  let {
    item,
    collapsed,
    unreadCount = 0,
    replyPersona = null,
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
    onOpenThread,
    onEdit,
    onDelete,
    onCopyLink,
    onMarkUnread,
    canRedactOthers = false,
    selected = false,
    layout = 'modern',
    members = [],
    onJumpToEvent,
    onOpenMedia,
    onVotePoll,
    onEndPoll,
    onPersonaOpenChange,
    placeholder = false,
    placeholderCharacters = 35,
  }: Props = $props();
  const core = useCoreClient();
  const personaStore = usePersonaStore();
  let profile = $state<ProfileView | null>(null);
  // Only a fallback: the core fills both fields, so most rows never scan.
  let senderMember = $derived(
    item.sender_name === null || item.sender_avatar === null
      ? findMember(members, item.sender)
      : undefined
  );
  let accountName = $derived(
    item.sender_name ??
      senderMember?.display_name ??
      profile?.display_name ??
      item.sender ??
      $i18n.t('timeline.unknownSender')
  );
  let persona = $derived(item.per_message_profile);
  let senderName = $derived(persona?.display_name ?? accountName);
  let senderAvatar = $derived(
    persona?.avatar_url ?? item.sender_avatar ?? senderMember?.avatar_url ?? null
  );
  let personaTint = $derived(personaWithColor(persona));
  let pronouns = $derived(
    visiblePronouns(persona?.pronouns ?? profile?.pronouns ?? [], {
      language: $i18n.resolvedLanguage ?? $i18n.language,
      filterByLanguage: preferences.filterPronounsByLanguage,
      limit: pronounPillLimit(preferences.pronounPillLimit),
    })
  );
  let replyName = $derived(
    replyPersona?.display_name ??
      item.in_reply_to?.sender_name ??
      findMember(members, item.in_reply_to?.sender)?.display_name ??
      item.in_reply_to?.sender ??
      $i18n.t('timeline.unknownSender')
  );
  let replyBody = $derived(stripReplyFallback(item.in_reply_to?.body ?? '', replyPersona));

  let emote = $derived(item.content.kind === 'message' && item.content.emote);
  let notice = $derived(item.content.kind === 'message' && item.content.notice);
  let jumbo = $derived(
    item.content.kind === 'message' && !item.content.emote
      ? jumboEmojiLevel(item.content.body)
      : null
  );
  let stalled = $derived(
    item.send_state?.status === 'failed' && !item.send_state.recoverable ? item.send_state : null
  );
  let pending = $derived(
    item.send_state?.status === 'sending' ||
      (item.send_state?.status === 'failed' && item.send_state.recoverable)
  );
  let upload = $derived(
    item.send_state?.status === 'sending' ? (item.send_state.progress ?? null) : null
  );

  let actionable = $derived(item.event_id !== null && stalled === null && !pending);
  let editable = $derived(
    item.is_own && (item.content.kind === 'message' || item.content.kind === 'image')
  );
  let redactable = $derived(canRedact(item, canRedactOthers));
  const swipe = new MessageSwipe({
    enabled: () => actionable && actions.onReply !== undefined,
    canEdit: () => actionable && actions.onEdit !== undefined,
    onReply: () => actions.onReply?.(),
    onEdit: () => actions.onEdit?.(),
  });
  let avatarColor = $derived(personaTint || item.is_own ? undefined : senderColor(item.sender));
  let senderColors = $derived(
    senderDisplayColors(item.sender ?? '', profile, persona, item.is_own)
  );
  let accountColors = $derived(senderDisplayColors(item.sender ?? '', profile, null, item.is_own));

  $effect(() => {
    const userId = item.sender;
    profile = null;
    if (!userId) return;

    let current = true;
    void core.userProfile(userId).then(
      (next) => {
        if (current) profile = next;
      },
      () => {
        // A timeline should remain readable when an optional profile lookup fails.
      }
    );
    return () => {
      current = false;
    };
  });

  let actions = $derived.by(() => {
    const eventId = item.event_id ?? '';
    const body =
      item.content.kind === 'message' || item.content.kind === 'image' ? item.content.body : null;
    const html = item.content.kind === 'message' ? item.content.html : null;
    return {
      onReact: onToggleReaction
        ? (emoji: string) => {
            onToggleReaction(eventId, emoji);
          }
        : undefined,
      onAddReaction: onToggleReaction
        ? () => {
            emoteOpen = true;
          }
        : undefined,
      onViewReactions:
        item.reactions.length > 0
          ? () => {
              reactionsOpen = true;
            }
          : undefined,
      onReadReceipts: () => {
        receiptsOpen = true;
      },
      onMarkUnread:
        onMarkUnread && eventId !== ''
          ? () => {
              onMarkUnread(eventId);
            }
          : undefined,
      onReply: onReply
        ? () => {
            onReply(eventId);
          }
        : undefined,
      onEdit:
        editable && onEdit && body !== null
          ? () => {
              onEdit(
                eventId,
                body,
                html,
                item.content.kind === 'image'
                  ? {
                      source: item.content.source,
                      filename: item.content.filename,
                      mime: item.content.mime,
                      width: item.content.width,
                      height: item.content.height,
                    }
                  : undefined
              );
            }
          : undefined,
      onReproxy:
        editable && item.content.kind === 'message' && eventId !== ''
          ? () => {
              void personaStore.load();
              reproxyOpen = true;
            }
          : undefined,
      onDelete:
        redactable && onDelete
          ? () => {
              deleteOpen = true;
            }
          : undefined,
      onCopyText:
        body === null
          ? undefined
          : () => {
              void copyText();
            },
      onOpenThread: onOpenThread && threadTarget ? () => onOpenThread(threadTarget) : undefined,
      onCopyLink:
        onCopyLink && item.event_id
          ? () => {
              if (item.event_id) onCopyLink(item.event_id);
            }
          : undefined,
      pinned,
      bookmarked,
      onPin: roomId && eventId ? () => void togglePin(eventId) : undefined,
      onBookmark: roomId && eventId ? () => void toggleBookmark(eventId) : undefined,
      onForward:
        roomId && eventId && item.content.kind === 'message'
          ? () => {
              forwardOpen = true;
            }
          : undefined,
      onViewSource: roomId && eventId ? () => void openSource(eventId) : undefined,
      onReport:
        roomId && eventId && !item.is_own
          ? () => {
              reportOpen = true;
            }
          : undefined,
    };
  });

  async function togglePin(eventId: string): Promise<void> {
    try {
      await pinnedEvents.toggle(roomId, eventId);
    } catch (error) {
      console.warn('[sable timeline] pin failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    }
  }

  async function toggleBookmark(eventId: string): Promise<void> {
    try {
      await bookmarks.toggle(roomId, eventId);
    } catch (error) {
      console.warn('[sable timeline] bookmark failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    }
  }

  async function openSource(eventId: string): Promise<void> {
    try {
      source = await core.commands.eventSource(roomId, eventId);
      sourceOpen = true;
    } catch (error) {
      console.warn('[sable timeline] source unavailable', error);
      toasts.error($i18n.t('errors.actionFailed'));
    }
  }

  function report(reason: string | null): void {
    const eventId = item.event_id;
    if (!eventId) return;
    void core.commands.reportMessage(roomId, eventId, reason).catch((error: unknown) => {
      console.warn('[sable timeline] report failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    });
  }

  function forward(toRoomIds: string[]): void {
    const eventId = item.event_id;
    if (!eventId) return;
    for (const toRoomId of toRoomIds) {
      void core.commands.forwardMessage(roomId, eventId, toRoomId).catch((error: unknown) => {
        console.warn('[sable timeline] forward failed', error);
        toasts.error($i18n.t('errors.actionFailed'));
      });
    }
  }

  function reproxyKind(content: TimelineItemView['content']): MessageKind {
    if (content.kind !== 'message') return 'text';
    if (content.emote) return 'emote';
    return content.notice ? 'notice' : 'text';
  }

  async function reproxy(newPersona: PersonaView | null): Promise<void> {
    const eventId = item.event_id;
    if (!eventId || item.content.kind !== 'message') return;
    try {
      await core.commands.editMessage(roomId, eventId, item.content.body, {
        formatted: item.content.html,
        kind: reproxyKind(item.content),
        threadRoot: item.thread_root ?? null,
        persona: newPersona ? projectPersona(newPersona, preferences.personaFallback) : null,
      });
    } catch (error) {
      console.warn('[sable timeline] reproxy failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    }
  }

  let sheetOpen = $state(false);
  let emoteOpen = $state(false);
  let sourceOpen = $state(false);
  let reportOpen = $state(false);
  let forwardOpen = $state(false);
  let reproxyOpen = $state(false);
  let source = $state('');
  let threadTarget = $derived(item.thread_root ?? item.event_id);
  let threadSummary = $derived(item.thread_summary);
  const pinnedEvents = usePinnedEvents();
  const bookmarks = useBookmarks();
  let pinned = $derived(pinnedEvents.has(item.event_id));
  let bookmarked = $derived(bookmarks.has(roomId, item.event_id));
  let deleteOpen = $state(false);
  let reactionsOpen = $state(false);
  let reactionActive = $state(0);
  let receiptsOpen = $state(false);
  let messageRow = $state<HTMLElement | null>(null);
  let receiptReaders = $derived(item.read_by.filter((readerId) => readerId !== currentUserId));
  let showReceiptBadge = $derived(
    !preferences.hideReadReceipts && preferences.readReceiptPlacement === 'message'
  );

  const rowPress = new LongPress({
    enabled: () => actionable,
    onPress: () => (sheetOpen = true),
  });

  let engaged = $state(false);
  let actionsPinned = $state(false);

  function engage(): void {
    engaged = true;
  }

  function disengage(event: FocusEvent | PointerEvent): void {
    if (event instanceof FocusEvent && event.relatedTarget instanceof Node) {
      if (messageRow?.contains(event.relatedTarget)) return;
    } else if (!(event instanceof FocusEvent) && messageRow?.matches(':focus-within')) {
      return;
    }
    engaged = false;
  }

  function pinActions(open: boolean): void {
    actionsPinned = open;
    onPersonaOpenChange?.(open);
  }

  function openContextMenu(event: MouseEvent): void {
    if (rowPress.touch) {
      event.preventDefault();
      return;
    }
    if (!actionable) return;
    event.preventDefault();
    openMessageMenu.open(item.id, { x: event.clientX, y: event.clientY }, () => actions);
  }

  $effect(() => {
    if (sheetOpen) openMessageMenu.set(item.id, false);
  });

  // A virtualised row can unmount mid-press, so the pending timer has to go.
  onDestroy(() => {
    rowPress.cancel();
  });

  async function copyText(): Promise<void> {
    if (item.content.kind === 'message') await navigator.clipboard.writeText(item.content.body);
  }

  function confirmDelete(reason: string | null): void {
    if (item.event_id) onDelete?.(item.event_id, reason);
  }

  function openSenderProfile(event: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    if (item.sender) onSenderProfile?.(item.sender, event.currentTarget);
  }

  function mentionSender(): void {
    if (item.sender) onMentionUser?.(item.sender, accountName);
  }

  function openAccountFromPersona(): void {
    if (item.sender && messageRow) onSenderProfile?.(item.sender, messageRow);
  }
</script>

{#if placeholder}
  <article
    class={['message', 'placeholder-message', `layout-${layout}`, { collapsed }]}
    aria-hidden="true"
  >
    {#if layout === 'compact'}
      <div class="compact-gutter">
        <time><Skeleton class="placeholder-time" /></time>
        {#if !collapsed}<Skeleton class="compact-name placeholder-name" />{/if}
      </div>
    {:else if !collapsed}
      <Skeleton class="sable-avatar sable-avatar-small message-avatar placeholder-avatar" />
    {/if}
    <div class="message-content">
      {#if !collapsed && layout !== 'compact'}
        <header>
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
{:else if isMessageRow(item.content)}
  <article
    bind:this={messageRow}
    class={[
      'message',
      'sable-choice',
      `layout-${layout}`,
      {
        collapsed,
        pending,
        highlighted,
        persona: personaTint,
        own: item.is_own,
        'mention-silent': item.mention === 'silent',
        'mention-loud': item.mention === 'loud',
      },
    ]}
    data-selected={selected ? 'true' : undefined}
    style:--pmp-on-light={personaTint?.color_on_light ?? undefined}
    style:--pmp-on-dark={personaTint?.color_on_dark ?? undefined}
    style:--name-color-on-light={senderColors.nameColorLight ?? undefined}
    style:--name-color-on-dark={senderColors.nameColorDark ?? undefined}
    style:transform={swipe.offset === 0 ? undefined : `translateX(${String(-swipe.offset)}px)`}
    style:transition={swipe.dragging ? 'none' : undefined}
    onpointerdown={rowPress.start}
    onpointermove={rowPress.move}
    onpointerup={rowPress.end}
    onpointercancel={rowPress.end}
    onpointerenter={engage}
    onpointerleave={disengage}
    onfocusin={engage}
    onfocusout={disengage}
    oncontextmenu={openContextMenu}
    {@attach swipe.attach}
  >
    {#if swipe.offset > 0}
      <div
        class="swipe-action"
        class:armed={swipe.action !== 'none'}
        aria-hidden="true"
        style:width={`${String(swipe.offset)}px`}
        style:transform={`translateX(${String(swipe.offset)}px)`}
      >
        {#if swipe.action === 'edit'}
          <PencilSimpleIcon weight="bold" />
        {:else}
          <ReplyIcon weight="bold" />
        {/if}
      </div>
    {/if}
    {#if actionable && (engaged || actionsPinned)}
      <MessageActions
        {roomId}
        onPickerOpenChange={pinActions}
        onOverflowOpenChange={pinActions}
        {...actions}
      />
    {/if}
    {#if actionable}
      {#if sourceOpen}
        <MessageSourceDialog bind:open={sourceOpen} {source} />
      {/if}
      {#if reportOpen}
        <MessageReportDialog bind:open={reportOpen} onReport={report} />
      {/if}
      {#if forwardOpen}
        <MessageForwardDialog bind:open={forwardOpen} fromRoomId={roomId} onForward={forward} />
      {/if}
      {#if reproxyOpen}
        <MessageReproxyDialog
          bind:open={reproxyOpen}
          personas={personaStore.personas}
          current={item.per_message_profile}
          onChoose={(next) => void reproxy(next)}
        />
      {/if}
      {#if emoteOpen}
        <ReactionSheet
          bind:open={emoteOpen}
          {roomId}
          onPick={(key: string) => {
            onToggleReaction?.(item.event_id ?? '', key);
          }}
        />
      {/if}
      {#if sheetOpen}
        <MessageActionSheet
          bind:open={sheetOpen}
          preview={item.content.kind === 'message' ? item.content.body : null}
          {...actions}
        />
      {/if}
      {#if deleteOpen}
        <DeleteMessageDialog
          bind:open={deleteOpen}
          preview={item.content.kind === 'message' ? item.content.body : null}
          onConfirm={confirmDelete}
        />
      {/if}
      {#if reactionsOpen}
        <ReactionsDialog
          bind:open={reactionsOpen}
          bind:active={reactionActive}
          reactions={item.reactions}
          {members}
          onMemberProfile={onSenderProfile}
        />
      {/if}
      {#if receiptsOpen}
        <ReceiptsDialog
          bind:open={receiptsOpen}
          readers={receiptReaders}
          {members}
          onMemberProfile={onSenderProfile}
        />
      {/if}
    {/if}
    {#if layout === 'compact'}
      <div class="compact-gutter">
        <time datetime={new Date(item.timestamp).toISOString()}
          >{formatMessageTimestamp(item.timestamp)}</time
        >
        {#if onMentionUser && item.sender && !collapsed}
          <SenderName
            displayName={senderName}
            colors={senderColors}
            {pronouns}
            nameClass="compact-name"
            onMention={mentionSender}
          />
        {:else if !collapsed}
          <SenderName
            displayName={senderName}
            colors={senderColors}
            {pronouns}
            nameClass="compact-name"
          />
        {/if}
      </div>
    {:else if !collapsed}
      {#if persona && item.sender}
        <PersonaProfile
          profile={persona}
          accountId={item.sender}
          {accountName}
          label={$i18n.t('timeline.personaProfile', { name: senderName })}
          onOpenAccount={openAccountFromPersona}
          onOpenChange={onPersonaOpenChange}
        >
          <Avatar
            class="message-avatar"
            src={senderAvatar}
            size="small"
            color={senderAvatar ? undefined : avatarColor}
            name={senderName}
          />
        </PersonaProfile>
      {:else if item.sender && onSenderProfile}
        <button
          class="avatar-button"
          type="button"
          aria-label={$i18n.t('timeline.senderProfile', { name: senderName })}
          onclick={openSenderProfile}
        >
          <Avatar
            class="message-avatar"
            src={senderAvatar}
            size="small"
            color={senderAvatar ? undefined : avatarColor}
            name={senderName}
          />
        </button>
      {:else}
        <Avatar
          class="message-avatar"
          src={senderAvatar}
          size="small"
          color={senderAvatar ? undefined : avatarColor}
          name={senderName}
        />
      {/if}
    {/if}
    <div class="message-content">
      {#if !collapsed && layout !== 'compact'}
        <header>
          {#if !emote}
            <SenderName
              displayName={senderName}
              colors={senderColors}
              {pronouns}
              onMention={onMentionUser && item.sender ? mentionSender : undefined}
            />
          {/if}
          <div class="message-details">
            {#if item.sender}
              <button
                class={!persona
                  ? 'via via-hidden'
                  : ['via', 'sender-identity-via', { tinted: accountColors.tinted }]}
                style:color={persona && !accountColors.tinted ? accountColors.nameColor : undefined}
                style:--name-color-on-light={persona
                  ? (accountColors.nameColorLight ?? undefined)
                  : undefined}
                style:--name-color-on-dark={persona
                  ? (accountColors.nameColorDark ?? undefined)
                  : undefined}
                type="button"
                aria-label={$i18n.t('timeline.viaAccount', { user: accountName })}
                onclick={openSenderProfile}>{persona ? accountName : item.sender}</button
              >
            {/if}
            <time datetime={new Date(item.timestamp).toISOString()}
              >{formatMessageTimestamp(item.timestamp)}</time
            >
          </div>
        </header>
      {/if}
      <div class="message-main">
        {#if item.in_reply_to}
          {@const tint = personaWithColor(replyPersona)}
          {@const target = item.in_reply_to.event_id}
          <button
            class={['reply-preview', { persona: tint }]}
            type="button"
            style:--pmp-on-light={tint?.color_on_light ?? undefined}
            style:--pmp-on-dark={tint?.color_on_dark ?? undefined}
            onclick={() => {
              onJumpToEvent?.(target);
            }}
          >
            <ReplyIcon class="reply-icon" />
            <span class="reply-line"><strong>{replyName}</strong> {replyBody}</span>
          </button>
        {/if}
        {#if item.content.kind === 'message' && item.content.emote}
          <div class="emote">
            <span
              class={['sender', 'sender-identity-name', { tinted: senderColors.tinted }]}
              style:color={senderColors.tinted ? undefined : senderColors.nameColor}
              >* {senderName}</span
            >
            <FormattedBody html={item.content.html} {onMatrixLink} />
          </div>
        {:else if item.content.kind === 'message'}
          <div
            class={[
              jumbo === null ? undefined : `jumbo jumbo-${String(jumbo)}`,
              { notice, 'has-edited': item.content.edited },
            ]}
          >
            <FormattedBody html={item.content.html} {onMatrixLink} />
            <!-- Trails the body, where the edit happened, not the header. -->
            {#if item.content.edited}
              <span class="edited">{$i18n.t('timeline.edited')}</span>
            {/if}
          </div>
          {@const previewUrl = firstPreviewableLink(item.content.html)}
          {#if previewUrl}
            <LinkPreviewCard url={previewUrl} />
          {/if}
        {:else}
          <MessageBody
            {item}
            {members}
            {canRedactOthers}
            {onMatrixLink}
            {onOpenMedia}
            {onVotePoll}
            {onEndPoll}
            {onSenderProfile}
          />
        {/if}
        {#if threadSummary && onOpenThread && threadTarget}
          {@const target = threadTarget}
          <button
            type="button"
            class="thread-summary"
            onclick={() => {
              onOpenThread(target);
            }}
          >
            <ThreadIcon size={14} aria-hidden="true" />
            <span class="thread-count"
              >{$i18n.t('timeline.threadReplies', { count: threadSummary.num_replies })}</span
            >
            {#if threadSummary.latest_body}
              <span class="thread-latest">{threadSummary.latest_body}</span>
            {/if}
          </button>
        {:else if item.thread_root && onOpenThread}
          {@const target = item.thread_root}
          <button
            type="button"
            class="thread-summary"
            onclick={() => {
              onOpenThread(target);
            }}
          >
            <ThreadIcon size={14} aria-hidden="true" />
            <span class="thread-count">{$i18n.t('timeline.thread')}</span>
          </button>
        {/if}
        {#if item.reactions.length > 0}
          <MessageReactions
            reactions={item.reactions}
            eventId={item.event_id}
            {currentUserId}
            {members}
            {roomId}
            {actionable}
            onReact={actions.onReact}
            {onToggleReaction}
            onViewReactions={(index: number) => {
              reactionActive = index;
              reactionsOpen = true;
            }}
          />
        {/if}
        {#if upload}
          <progress
            class="upload"
            max={upload.total}
            value={upload.current}
            aria-label={$i18n.t('timeline.uploading')}
          ></progress>
        {/if}
        {#if stalled}
          <p class="send-failure">
            <span title={stalled.error}>{$i18n.t('timeline.sendFailed')}</span>
            {#if item.transaction_id}
              {@const transactionId = item.transaction_id}
              <button
                type="button"
                onclick={() => {
                  onRetrySend?.(transactionId);
                }}
              >
                {$i18n.t('timeline.retrySend')}
              </button>
              <button
                type="button"
                onclick={() => {
                  onCancelSend?.(transactionId);
                }}
              >
                {$i18n.t('timeline.cancelSend')}
              </button>
            {/if}
          </p>
        {/if}
      </div>
      {#if actionable && showReceiptBadge}
        <ReadReceiptStack
          readers={receiptReaders}
          {members}
          expanded={receiptsOpen}
          onOpen={() => {
            receiptsOpen = true;
          }}
        />
      {/if}
    </div>
  </article>
{:else}
  <TimelineNotice {item} {unreadCount} {onSenderProfile} />
{/if}

<style>
  .placeholder-message {
    pointer-events: none;
  }

  .placeholder-message :global(.sable-skeleton) {
    background: color-mix(in srgb, var(--sable-bg-on-container) 18%, var(--sable-bg-container));
  }

  .placeholder-body {
    line-height: var(--line-height-body);
  }

  .placeholder-copy {
    background: color-mix(in srgb, var(--sable-bg-on-container) 18%, var(--sable-bg-container));
    border-radius: var(--radius);
    box-decoration-break: clone;
    color: transparent;
    overflow-wrap: anywhere;
    user-select: none;
  }

  @media (prefers-reduced-motion: no-preference) {
    .placeholder-copy {
      animation: sable-skeleton-pulse 1.8s ease-in-out infinite;
    }
  }

  :global(.sable-skeleton.placeholder-avatar) {
    background: color-mix(in srgb, var(--sable-bg-on-container) 24%, var(--sable-bg-container));
    border-radius: var(--radii-400);
  }

  :global(.sable-skeleton.placeholder-name) {
    height: var(--font-size-body);
    width: 6.5rem;
  }

  :global(.sable-skeleton.placeholder-time) {
    height: var(--font-size-small);
    width: 3rem;
  }

  .thread-summary {
    align-items: center;
    background: none;
    border: none;
    color: var(--sable-primary-main);
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    margin-top: var(--space-050);
    max-width: 100%;
    padding: 0;
    text-align: left;
  }

  .thread-count {
    flex: none;
    font-weight: var(--font-weight-medium);
  }

  .thread-summary:hover .thread-count {
    text-decoration: underline;
  }

  .thread-latest {
    color: var(--sable-surface-var-on-container);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .message {
    display: flex;
    gap: var(--timeline-row-gap);
    overflow-wrap: anywhere;
    padding: var(--timeline-row-padding) 0;
    position: relative;
  }

  @media (prefers-reduced-motion: no-preference) {
    .message {
      transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
    }
  }

  .swipe-action {
    align-items: center;
    bottom: 0;
    color: var(--sable-sec-main);
    display: flex;
    justify-content: center;
    overflow: hidden;
    pointer-events: none;
    position: absolute;
    right: 0;
    top: 0;
  }

  .swipe-action.armed {
    color: var(--sable-primary-main);
  }

  .message:focus-within :global(.message-actions) {
    opacity: 1;
    pointer-events: auto;
  }

  .message.mention-silent,
  .message.mention-loud {
    border-inline-start: calc(var(--border-width) * 4) solid;
    border-radius: 0 var(--radius) var(--radius) 0;
    padding-inline: var(--space-200);
  }

  /* The leading border carries the signal, so the fill stays quiet enough to
     read a long message on. */
  .message.mention-silent {
    background: color-mix(in oklab, var(--sable-sec-container) 10%, transparent);
    border-inline-start-color: var(--sable-sec-main);
  }

  .message.mention-loud {
    background: color-mix(in oklab, var(--sable-warn-container) 16%, transparent);
    border-inline-start-color: var(--sable-warn-main);
  }

  /* The sheet pairs multi-select with keyboard focus; focus is the half that
     exists today, and it survives on touch where hover does not. */
  .message[data-selected='true'] {
    background: var(--sable-primary-container);
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 var(--border-width) var(--sable-primary-container-line);
  }

  .message:has(:focus-visible):not([data-selected='true']) {
    background: var(--sable-bg-container-hover);
    border-radius: var(--radius);
  }

  .message.collapsed {
    padding-left: calc(var(--avatar-size-small) + var(--timeline-row-gap));
    padding-top: 0;
  }

  .message.pending {
    opacity: 0.65;
  }

  .message.highlighted {
    border-radius: var(--radius);
  }

  /* Glyph sizes for emoji-only messages, deliberately off the type scale. */
  .jumbo {
    --jumbo-size-1: 2.4rem;
    --jumbo-size-2: 1.9rem;
    --jumbo-size-3: 1.5rem;
    --jumbo-size-4: 1.25rem;
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
      background-color: var(--sable-primary-container);
    }

    16% {
      background-color: var(--sable-primary-container-active);
    }

    33%,
    100% {
      background-color: transparent;
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    .message.highlighted {
      animation: jump 6s var(--motion-easing-standard);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .message.highlighted {
      background-color: var(--sable-primary-container);
    }
  }

  @media (width >= 48rem) and (hover: hover) and (pointer: fine) {
    .message {
      margin-inline: calc(-1 * var(--page-gutter));
      padding-inline: var(--page-gutter);
    }

    .message.collapsed {
      padding-left: calc(var(--page-gutter) + var(--avatar-size-small) + var(--timeline-row-gap));
    }

    /* Matches the base mention rule's specificity, so the gutter the row's
       negative margin assumes survives. */
    .message.mention-silent,
    .message.mention-loud {
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

    .message:hover {
      background-color: var(--sable-surface-container-hover);
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

  /* Only the hashed sender colours are `-main` fills; an own or persona avatar
     keeps Avatar's own container pair, whose ink this would wash out. */
  .message:not(.own, .persona) :global(.sable-avatar.message-avatar) {
    color: var(--sable-primary-on-main);
  }

  .message-content {
    display: grid;
    flex: 1;
    grid-template-columns: minmax(0, 1fr) auto;
    min-width: 0;
  }

  .message-content > header {
    grid-column: 1 / -1;
  }

  .message-main {
    grid-column: 1;
    min-width: 0;
  }

  .message-content > :global(.read-receipt-stack) {
    align-self: end;
    grid-column: 2;
    margin-inline-start: var(--space-150);
  }

  .message header {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .message header .message-details {
    align-items: center;
    display: flex;
    flex-grow: 1;
    font-size: var(--font-size-small);
    justify-content: end;
  }

  .persona {
    --pmp-ink: var(--pmp-on-light, var(--sable-sec-on-container));
  }

  @media (prefers-color-scheme: dark) {
    :root:not(.light) .persona,
    :root.dark .persona {
      --pmp-ink: var(--pmp-on-dark, var(--sable-sec-on-container));
    }
  }

  @supports (color: oklch(from red l c h)) {
    .persona {
      --pmp-ink: oklch(
        from var(--pmp-on-light, var(--sable-sec-on-container)) clamp(0.25, l, 0.52)
          clamp(0, c, 0.19) h
      );
    }

    @media (prefers-color-scheme: dark) {
      :root:not(.light) .persona,
      :root.dark .persona {
        --pmp-ink: oklch(
          from var(--pmp-on-dark, var(--sable-sec-on-container)) clamp(0.72, l, 0.92)
            clamp(0, c, 0.16) h
        );
      }
    }
  }

  :root.dark .persona {
    --pmp-ink: var(--pmp-on-dark, var(--sable-sec-on-container));
  }

  @supports (color: oklch(from red l c h)) {
    :root.dark .persona {
      --pmp-ink: oklch(
        from var(--pmp-on-dark, var(--sable-sec-on-container)) clamp(0.72, l, 0.92)
          clamp(0, c, 0.16) h
      );
    }
  }

  .message.persona :global(.message-avatar) {
    color: var(--pmp-ink);
  }

  .message.persona :global(.message-avatar .sable-avatar-fallback) {
    background: color-mix(in oklab, var(--pmp-ink) 18%, var(--sable-surface-var-container));
  }

  .via {
    background: none;
    border: none;
    border-radius: var(--radius-pill);
    cursor: pointer;
    letter-spacing: 0.01em;
  }

  .via.via-hidden {
    display: none;
  }

  @media (width >= 48rem) {
    .via.via-hidden {
      display: revert;
      opacity: 0;
    }
  }

  .via:hover {
    background: var(--sable-surface-var-container-hover);
  }

  .emote {
    color: var(--sable-success-main);
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

  .has-edited :global(.formatted-body) {
    display: inline;
  }

  time,
  .edited {
    color: var(--sable-surface-var-on-container);
  }

  .edited {
    font-size: var(--font-size-small);
    margin-inline-start: var(--space-100);
  }

  /* `m.notice` is usually a bot, and reads as an aside. */
  .notice {
    color: var(--sable-surface-var-on-container);
  }

  .send-failure {
    align-items: baseline;
    color: var(--sable-crit-main);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    margin-top: var(--space-050);
  }

  .send-failure button {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 0;
    position: relative;
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }

  /* Small text buttons, so the tap area is grown without moving the baseline. */
  .send-failure button::after {
    content: '';
    inset: -0.5rem -0.25rem;
    position: absolute;
  }

  .send-failure button:focus-visible {
    border-radius: 0.125rem;
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: 0.15rem;
  }

  .upload {
    accent-color: var(--sable-primary-main);
    display: block;
    height: 0.25rem;
    margin-top: var(--space-100);
    width: min(100%, 16rem);
  }

  .reply-preview {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: grid;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    grid-template-columns: auto minmax(0, 1fr);
    line-height: 1.4;
    margin: 0;
    margin-bottom: var(--space-100);
    padding: var(--space-100) var(--space-200);
    text-align: start;
    width: 100%;
  }

  .reply-preview:hover {
    background: var(--sable-surface-var-container);
  }

  .reply-preview :global(.reply-icon) {
    color: var(--sable-primary-main);
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .reply-line {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reply-preview strong {
    color: var(--sable-sec-on-container);
  }

  .reply-preview.persona strong {
    color: var(--pmp-ink);
  }

  /* bits-ui renders the trigger, so the row's scoped `.reaction` cannot reach it. */

  :global(.reaction-tooltip) {
    animation: tooltip-in var(--motion-slow) var(--motion-easing-emphasized) both;
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    box-sizing: border-box;
    color: var(--sable-bg-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    max-width: min(15rem, calc(100vw - 2rem));
    overflow-wrap: anywhere;
    padding: var(--space-200) var(--space-250);
    white-space: normal;
    z-index: var(--layer-tooltip);
  }

  @keyframes tooltip-in {
    from {
      opacity: 0;
      transform: translateY(0.25rem) scale(0.96);
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    .via {
      transition: background-color var(--motion-fast) var(--motion-easing-standard);
    }

    .via-hidden {
      transition: opacity var(--motion-fast) var(--motion-easing-standard);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.reaction-tooltip) {
      animation: none;
    }
  }

  .message.mention-loud :global(a[data-matrix-link]) {
    background: var(--sable-warn-container-active);
    border-color: var(--sable-warn-container-line);
    color: var(--sable-warn-on-container);
  }

  .message[data-selected='true'] .body,
  .message[data-selected='true'] time {
    color: var(--sable-primary-on-container);
  }

  /* Layout modes stay in one block at the end: each overrides a base rule
     above, and a second copy elsewhere would drift out of sync. */
  .message.layout-compact {
    align-items: baseline;
    gap: var(--space-300);
  }

  .message.layout-compact.collapsed {
    padding-left: 0;
  }

  .compact-gutter {
    align-items: baseline;
    display: flex;
    flex: 0 0 clamp(7.5rem, 20%, 10.625rem);
    gap: var(--space-200);
    justify-content: flex-end;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .message.layout-compact .compact-gutter time {
    color: var(--sable-surface-var-on-container);
    flex: none;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }

  .message.layout-bubble .message-main {
    align-items: flex-start;
    display: flex;
    flex-direction: column;
  }

  /* `.body` only ever matches a media caption, which stays flat. */
  .message.layout-bubble :global(.formatted-body) {
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    color: var(--sable-surface-on-container);
    max-width: 50rem;
    padding: var(--space-200) var(--space-300);
  }

  .message.layout-bubble.own :global(.formatted-body) {
    background: var(--sable-primary-container);
    border-color: var(--sable-primary-container-line);
    color: var(--sable-primary-on-container);
  }

  /* The one mode where your own side changes. */
  .message.layout-bubble.own {
    flex-direction: row-reverse;
  }

  .message.layout-bubble.own .message-main {
    align-items: flex-end;
  }

  .message.layout-bubble.own header {
    flex-direction: row-reverse;
  }

  .message.layout-bubble.own.collapsed {
    padding-left: 0;
    padding-right: calc(var(--avatar-size-small) + var(--space-250));
  }
</style>
