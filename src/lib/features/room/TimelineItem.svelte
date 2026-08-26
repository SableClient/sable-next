<script lang="ts">
  import PronounPill from '#lib/ui/primitives/PronounPill.svelte';
  import { ContextMenu } from 'bits-ui';
  import { onDestroy } from 'svelte';

  import type { MemberView } from '#src/generated/MemberView';
  import type { PerMessageProfileView } from '#src/generated/PerMessageProfileView';
  import type { ProfileView } from '#src/generated/ProfileView';
  import type { TimelineItemView } from '#src/generated/TimelineItemView';

  import { useCoreClient } from '#lib/core/context.js';
  import { LongPress } from './long-press.svelte.js';
  import { findMember, isCaption, personaWithColor, stripReplyFallback } from './members.js';
  import { MessageSwipe } from './message-swipe.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import type { TimelineLayout } from '#lib/settings/preferences.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import MediaContent from '#lib/ui/MediaContent.svelte';
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';

  import FormattedBody from './FormattedBody.svelte';
  import MessageReactions from './MessageReactions.svelte';
  import { usePinnedEvents } from './pinned-events.svelte.js';
  import TimelineNotice from './TimelineNotice.svelte';
  import TimelineGallery from './TimelineGallery.svelte';
  import TimelineLocation from './TimelineLocation.svelte';
  import TimelinePoll from './TimelinePoll.svelte';
  import MessageActions from './MessageActions.svelte';
  import MessageActionSheet from './MessageActionSheet.svelte';
  import IconContext from 'phosphor-svelte/lib/IconContext';

  import MessageQuickReactions from './MessageQuickReactions.svelte';
  import MessageForwardDialog from './MessageForwardDialog.svelte';
  import MessageReportDialog from './MessageReportDialog.svelte';
  import MessageSourceDialog from './MessageSourceDialog.svelte';
  import ReactionSheet from './ReactionSheet.svelte';
  import { messageMenuRows } from './message-menu-items';
  import { openMessageMenu } from './message-menu-open.svelte.js';
  import '#lib/ui/primitives/menu.css';
  import PersonaProfile from './PersonaProfile.svelte';
  import ReactionsDialog from './ReactionsDialog.svelte';
  import ReceiptsDialog from './ReceiptsDialog.svelte';
  import DeleteMessageDialog from './DeleteMessageDialog.svelte';
  import type { MatrixLink } from './matrix-link';
  import './avatar-button.css';
  import {
    formatTime,
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
    onRetrySend?: (transactionId: string) => void;
    onCancelSend?: (transactionId: string) => void;
    currentUserId?: string | null;
    onToggleReaction?: (eventId: string, key: string) => void;
    onReply?: (eventId: string) => void;
    onEdit?: (eventId: string, body: string, html: string | null) => void;
    onDelete?: (eventId: string, reason: string | null) => void;
    onCopyLink?: (eventId: string) => void;
    canRedactOthers?: boolean;
    selected?: boolean;
    layout?: TimelineLayout;
    members?: readonly MemberView[];
    onJumpToEvent?: (eventId: string) => void;
    onOpenMedia?: (eventId: string) => void;
    onVotePoll?: (eventId: string, answers: string[]) => void;
    onEndPoll?: (eventId: string) => void;
    onPersonaOpenChange?: (open: boolean) => void;
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
    onRetrySend,
    onCancelSend,
    currentUserId = null,
    onToggleReaction,
    onReply,
    onEdit,
    onDelete,
    onCopyLink,
    canRedactOthers = false,
    selected = false,
    layout = 'modern',
    members = [],
    onJumpToEvent,
    onOpenMedia,
    onVotePoll,
    onEndPoll,
    onPersonaOpenChange,
  }: Props = $props();
  const core = useCoreClient();
  let profile = $state<ProfileView | null>(null);
  let senderMember = $derived(findMember(members, item.sender));
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
  /* Editing needs a body to put back in the composer, so it is text-only.
     Redaction is not. */
  let ownText = $derived(item.is_own && item.content.kind === 'message');
  let redactable = $derived(canRedact(item, canRedactOthers));
  const swipe = new MessageSwipe({
    enabled: () => actionable && actions.onReply !== undefined,
    canEdit: () => actionable && actions.onEdit !== undefined,
    onReply: () => actions.onReply?.(),
    onEdit: () => actions.onEdit?.(),
  });
  let avatarColor = $derived(personaTint || item.is_own ? undefined : senderColor(item.sender));
  let nameColor = $derived(
    item.is_own ? 'var(--sable-primary-on-container)' : senderColor(item.sender)
  );
  let nameColorLight = $derived(
    personaTint?.color_on_light ?? profile?.name_color_light ?? profile?.name_color_dark ?? null
  );
  let nameColorDark = $derived(
    personaTint?.color_on_dark ?? profile?.name_color_dark ?? profile?.name_color_light ?? null
  );
  let nameTinted = $derived(nameColorLight !== null || nameColorDark !== null);

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
    const body = item.content.kind === 'message' ? item.content.body : null;
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
      onReply: onReply
        ? () => {
            onReply(eventId);
          }
        : undefined,
      onEdit:
        ownText && onEdit && body !== null
          ? () => {
              onEdit(eventId, body, html);
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
    }
  }

  async function toggleBookmark(eventId: string): Promise<void> {
    try {
      bookmarked = await core.commands.setBookmark(roomId, eventId, !bookmarked);
    } catch (error) {
      console.warn('[sable timeline] bookmark failed', error);
    }
  }

  async function openSource(eventId: string): Promise<void> {
    try {
      source = await core.commands.eventSource(roomId, eventId);
      sourceOpen = true;
    } catch (error) {
      console.warn('[sable timeline] source unavailable', error);
    }
  }

  function report(reason: string | null): void {
    const eventId = item.event_id;
    if (!eventId) return;
    void core.commands.reportMessage(roomId, eventId, reason).catch((error: unknown) => {
      console.warn('[sable timeline] report failed', error);
    });
  }

  function forward(toRoomId: string): void {
    const eventId = item.event_id;
    if (!eventId) return;
    void core.commands.forwardMessage(roomId, eventId, toRoomId).catch((error: unknown) => {
      console.warn('[sable timeline] forward failed', error);
    });
  }

  let sheetOpen = $state(false);
  let emoteOpen = $state(false);
  let sourceOpen = $state(false);
  let reportOpen = $state(false);
  let forwardOpen = $state(false);
  let source = $state('');
  const pinnedEvents = usePinnedEvents();
  let pinned = $derived(pinnedEvents.has(item.event_id));
  let bookmarked = $state(false);
  let deleteOpen = $state(false);
  let reactionsOpen = $state(false);
  let reactionActive = $state(0);
  let receiptsOpen = $state(false);
  let messageRow = $state<HTMLElement | null>(null);

  const rowPress = new LongPress({
    enabled: () => actionable,
    onPress: () => (sheetOpen = true),
  });

  function suppressTouchContextMenu(event: MouseEvent): void {
    if (!rowPress.touch) return;
    event.preventDefault();
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

  function openAccountFromPersona(): void {
    if (item.sender && messageRow) onSenderProfile?.(item.sender, messageRow);
  }
</script>

{#if isMessageRow(item.content)}
  <ContextMenu.Root
    bind:open={
      () => openMessageMenu.isOpen(item.id),
      (open: boolean) => {
        openMessageMenu.set(item.id, open);
      }
    }
  >
    <ContextMenu.Trigger disabled={!actionable || rowPress.touch}>
      <article
        bind:this={messageRow}
        class={[
          'message',
          `layout-${layout}`,
          {
            collapsed,
            pending,
            highlighted,
            selected,
            persona: personaTint,
            own: item.is_own,
            'mention-silent': item.mention === 'silent',
            'mention-loud': item.mention === 'loud',
          },
        ]}
        style:--pmp-on-light={personaTint?.color_on_light ?? undefined}
        style:--pmp-on-dark={personaTint?.color_on_dark ?? undefined}
        style:--name-color-on-light={nameColorLight ?? undefined}
        style:--name-color-on-dark={nameColorDark ?? undefined}
        style:transform={swipe.offset === 0 ? undefined : `translateX(${String(-swipe.offset)}px)`}
        style:transition={swipe.dragging ? 'none' : undefined}
        onpointerdown={rowPress.start}
        onpointermove={rowPress.move}
        onpointerup={rowPress.end}
        onpointercancel={rowPress.end}
        oncontextmenu={suppressTouchContextMenu}
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
        {#if actionable}
          <MessageActions {roomId} onPickerOpenChange={onPersonaOpenChange} {...actions} />
          {#if sourceOpen}
            <MessageSourceDialog bind:open={sourceOpen} {source} />
          {/if}
          {#if reportOpen}
            <MessageReportDialog bind:open={reportOpen} onReport={report} />
          {/if}
          {#if forwardOpen}
            <MessageForwardDialog bind:open={forwardOpen} fromRoomId={roomId} onForward={forward} />
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
            />
          {/if}
          {#if receiptsOpen}
            <ReceiptsDialog bind:open={receiptsOpen} readers={item.read_by} {members} />
          {/if}
        {/if}
        {#if layout === 'compact'}
          <div class="compact-gutter">
            <time datetime={new Date(item.timestamp).toISOString()}
              >{formatTime(item.timestamp)}</time
            >
            <span
              class="compact-name"
              class:tinted={nameTinted}
              style:color={nameTinted ? undefined : nameColor}
            >
              {collapsed ? '' : senderName}
            </span>
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
                <span
                  class="sender"
                  class:tinted={nameTinted}
                  style:color={nameTinted ? undefined : nameColor}
                >
                  {senderName}
                </span>
              {/if}
              {#each persona?.pronouns ?? profile?.pronouns ?? [] as pronoun, index (index)}
                <PronounPill lang={pronoun.language ?? undefined}>{pronoun.summary}</PronounPill>
              {/each}
              <div class="message-details">
                {#if item.sender}
                  <button
                    class={!persona ? 'via via-hidden' : 'via'}
                    type="button"
                    aria-label={$i18n.t('timeline.viaAccount', { user: accountName })}
                    onclick={openSenderProfile}>{persona ? accountName : item.sender}</button
                  >
                {/if}
                <time datetime={new Date(item.timestamp).toISOString()}
                  >{formatTime(item.timestamp)}</time
                >
              </div>
            </header>
          {/if}
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
                class="sender"
                class:tinted={nameTinted}
                style:color={nameTinted ? undefined : nameColor}>* {senderName}</span
              >
              <FormattedBody html={item.content.html} {onMatrixLink} />
            </div>
          {:else if item.content.kind === 'message'}
            <div class={[jumbo === null ? undefined : `jumbo jumbo-${String(jumbo)}`, { notice }]}>
              <FormattedBody html={item.content.html} {onMatrixLink} />
              <!-- Trails the body, where the edit happened, not the header. -->
              {#if item.content.edited}
                <span class="edited">{$i18n.t('timeline.edited')}</span>
              {/if}
            </div>
          {:else if item.content.kind === 'sticker'}
            <MediaImage
              class="sticker"
              source={item.content.source}
              alt={item.content.body}
              width={304}
              height={304}
              intrinsicWidth={item.content.width}
              intrinsicHeight={item.content.height}
              mime={item.content.mime}
              retryable
              onclick={() => item.event_id && onOpenMedia?.(item.event_id)}
            />
          {:else if item.content.kind === 'image'}
            <MediaImage
              class="image"
              source={item.content.source}
              alt={item.content.body}
              width={800}
              height={600}
              intrinsicWidth={item.content.width}
              intrinsicHeight={item.content.height}
              mime={item.content.mime}
              retryable
              onclick={() => item.event_id && onOpenMedia?.(item.event_id)}
            />
            {#if isCaption(item.content.body)}<p class="body">{item.content.body}</p>{/if}
          {:else if item.content.kind === 'gallery'}
            <TimelineGallery
              items={item.content.items}
              body={item.content.body}
              html={item.content.html}
              {onMatrixLink}
            />
          {:else if item.content.kind === 'location'}
            <TimelineLocation
              body={item.content.body}
              geoUri={item.content.geo_uri}
              latitude={item.content.latitude}
              longitude={item.content.longitude}
            />
          {:else if item.content.kind === 'poll'}
            <TimelinePoll
              poll={item.content.poll}
              eventId={item.event_id}
              canEnd={item.is_own || canRedactOthers}
              onVote={onVotePoll}
              onEnd={onEndPoll}
            />
          {:else if item.content.kind === 'video' || item.content.kind === 'audio' || item.content.kind === 'file'}
            <MediaContent
              class="media"
              source={item.content.source}
              mime={item.content.mime}
              body={item.content.body}
              kind={item.content.kind}
              width={item.content.kind === 'video' ? item.content.width : null}
              height={item.content.kind === 'video' ? item.content.height : null}
            />
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
      </article>
    </ContextMenu.Trigger>
    {#if actionable}
      <ContextMenu.Portal>
        <ContextMenu.Content class="sable-menu message-menu" loop collisionPadding={8}>
          <IconContext values={{ 'aria-hidden': 'true' }}>
            {#if actions.onReact}
              {@const react = actions.onReact}
              <MessageQuickReactions count={4} onReact={react} />
            {/if}
            {#each messageMenuRows(actions) as row (row.key)}
              {@const RowIcon = row.icon}
              {#if row.separated}
                <ContextMenu.Separator class="sable-menu-separator" />
              {/if}
              <ContextMenu.Item
                class={[
                  'sable-menu-item sable-menu-item-trailing-icon',
                  row.destructive && 'sable-menu-item-destructive',
                ]}
                onclick={row.run}
              >
                <RowIcon />
                <span>{$i18n.t(row.label)}</span>
              </ContextMenu.Item>
            {/each}
          </IconContext>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    {/if}
  </ContextMenu.Root>
{:else}
  <TimelineNotice {item} {unreadCount} {onSenderProfile} />
{/if}

<style>
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
  .message.selected,
  .message:has(:focus-visible) {
    background: var(--sable-primary-container);
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 var(--border-width) var(--sable-primary-container-line);
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
      padding-inline: calc(var(--page-gutter) - 4px) var(--page-gutter);
    }

    /* The rule above resets the whole shorthand, and a collapsed row still
       owes the avatar gutter. */
    .message.collapsed.mention-silent,
    .message.collapsed.mention-loud {
      padding-left: calc(
        var(--page-gutter) - 4px + var(--avatar-size-small) + var(--timeline-row-gap)
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
    flex: 1;
    min-width: 0;
  }

  .message header {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .message header .message-details {
    align-items: baseline;
    display: flex;
    flex-grow: 1;
    font-size: var(--font-size-t200);
    justify-content: end;
  }

  .sender {
    font-weight: var(--font-weight-bold);
    letter-spacing: -0.005em;
    max-width: 24ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sender.tinted,
  .compact-name.tinted {
    color: var(--name-color-on-light);
  }

  @media (prefers-color-scheme: dark) {
    :root:not(.light) .sender.tinted,
    :root:not(.light) .compact-name.tinted,
    :root.dark .sender.tinted,
    :root.dark .compact-name.tinted {
      color: var(--name-color-on-dark);
    }
  }

  @supports (color: oklch(from red l c h)) {
    .sender.tinted,
    .compact-name.tinted {
      color: oklch(from var(--name-color-on-light) clamp(0.25, l, 0.52) clamp(0, c, 0.19) h);
    }

    @media (prefers-color-scheme: dark) {
      :root:not(.light) .sender.tinted,
      :root:not(.light) .compact-name.tinted,
      :root.dark .sender.tinted,
      :root.dark .compact-name.tinted {
        color: oklch(from var(--name-color-on-dark) clamp(0.72, l, 0.92) clamp(0, c, 0.16) h);
      }
    }
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
    background: color-mix(in oklab, var(--pmp-ink) 18%, var(--sable-surface-var-container));
    color: var(--pmp-ink);
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
    margin-top: var(--space-hairline);
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

  .body,
  .reply-preview {
    margin: 0;
  }

  .body {
    line-height: var(--line-height-body);
    white-space: pre-wrap;
  }

  :global(.image) {
    border-radius: var(--radius);
    display: block;
    margin-top: var(--space-100);
    width: min(
      100%,
      var(--timeline-media-max),
      calc(var(--timeline-media-max) * var(--media-ratio))
    );
  }

  :global(.sticker) {
    border-radius: var(--radius);
    display: block;
    margin-top: var(--space-100);
    width: var(--timeline-sticker-width);
  }

  :global(.media) {
    width: min(100%, var(--timeline-media-max));
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
    gap: var(--space-1);
    grid-template-columns: auto minmax(0, 1fr);
    line-height: 1.4;
    margin-bottom: var(--space-100);
    padding: var(--space-100) var(--space-1);
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
    .reaction {
      transition:
        background-color var(--motion-normal) var(--motion-easing-standard),
        border-color var(--motion-normal) var(--motion-easing-standard);
    }

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

  @media (hover: hover) and (pointer: fine) {
    .reaction:hover:not(:disabled) {
      background: var(--sable-surface-var-container-hover);
    }

    .reaction.mine:hover:not(:disabled) {
      background: var(--sable-primary-container-hover);
    }
  }

  .message.mention-loud :global(a[data-matrix-link]) {
    background: var(--sable-warn-container-active);
    border-color: var(--sable-warn-container-line);
    color: var(--sable-warn-on-container);
  }

  .message.selected .body,
  .message.selected time {
    color: var(--sable-primary-on-container);
  }

  /* Layout modes stay in one block at the end: each overrides a base rule
     above, and a second copy elsewhere would drift out of sync. */
  .message.layout-compact {
    align-items: baseline;
    gap: var(--space-2);
  }

  .message.layout-compact.collapsed {
    padding-left: 0;
  }

  .compact-gutter {
    align-items: baseline;
    display: flex;
    flex: 0 0 clamp(6rem, 20%, 10.625rem);
    gap: var(--space-1);
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

  .compact-name {
    font-weight: var(--font-weight-bold);
    letter-spacing: -0.005em;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .message.layout-bubble .message-content {
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
    padding: var(--space-1) var(--space-2);
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

  .message.layout-bubble.own .message-content {
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
