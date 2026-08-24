<script lang="ts">
  import PronounPill from '#lib/ui/primitives/PronounPill.svelte';
  import { Collapsible, ContextMenu, Tooltip as BitsTooltip } from 'bits-ui';
  import { onDestroy } from 'svelte';

  import type { MemberView } from '#src/generated/MemberView';
  import type { PerMessageProfileView } from '#src/generated/PerMessageProfileView';
  import type { ProfileView } from '#src/generated/ProfileView';
  import type { TimelineItemView } from '#src/generated/TimelineItemView';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import type { TimelineLayout } from '#lib/settings/preferences.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import MediaContent from '#lib/ui/MediaContent.svelte';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';

  import FormattedBody from './FormattedBody.svelte';
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
  import ReactionPicker from './ReactionPicker.svelte';
  import ReactionsDialog from './ReactionsDialog.svelte';
  import ReceiptsDialog from './ReceiptsDialog.svelte';
  import DeleteMessageDialog from './DeleteMessageDialog.svelte';
  import type { MatrixLink } from './matrix-link';
  import StateEventText from './StateEventText.svelte';
  import './avatar-button.css';
  import {
    formatDate,
    formatTime,
    initials,
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
  let accountName = $derived(item.sender_name ?? item.sender ?? $i18n.t('timeline.unknownSender'));
  let persona = $derived(item.per_message_profile);
  let senderName = $derived(persona?.display_name ?? accountName);
  let senderAvatar = $derived(persona?.avatar_url ?? item.sender_avatar);
  let personaTint = $derived(tinted(persona));
  let replyName = $derived(
    replyPersona?.display_name ??
      item.in_reply_to?.sender_name ??
      item.in_reply_to?.sender ??
      $i18n.t('timeline.unknownSender')
  );
  let replyBody = $derived(stripFallback(item.in_reply_to?.body ?? '', replyPersona));

  function tinted(profile: PerMessageProfileView | null): PerMessageProfileView | null {
    return profile && (profile.color_on_light ?? profile.color_on_dark) !== null ? profile : null;
  }

  function isCaption(body: string): boolean {
    return !/^\S+\.[a-z0-9]{2,4}$/i.test(body);
  }

  function stripFallback(body: string, profile: PerMessageProfileView | null): string {
    if (!profile) return body;
    const name = profile.display_name?.trim();
    if (name && body.startsWith(`${name}: `)) return body.slice(name.length + 2);
    if (!profile.has_fallback) return body;
    const separator = body.indexOf(': ');
    return separator === -1 ? body : body.slice(separator + 2);
  }
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
  let avatarColor = $derived(personaTint || item.is_own ? undefined : senderColor(item.sender));
  let nameColor = $derived(
    item.is_own ? 'var(--sable-primary-on-container)' : senderColor(item.sender)
  );
  let profile = $state<ProfileView | null>(null);
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
    if (!userId || personaTint) return;

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
      const ids = await core.setPinned(roomId, eventId, !pinned);
      pinned = ids.includes(eventId);
    } catch (error) {
      console.warn('[sable timeline] pin failed', error);
    }
  }

  async function toggleBookmark(eventId: string): Promise<void> {
    try {
      bookmarked = await core.setBookmark(roomId, eventId, !bookmarked);
    } catch (error) {
      console.warn('[sable timeline] bookmark failed', error);
    }
  }

  async function openSource(eventId: string): Promise<void> {
    try {
      source = await core.eventSource(roomId, eventId);
      sourceOpen = true;
    } catch (error) {
      console.warn('[sable timeline] source unavailable', error);
    }
  }

  function report(reason: string | null): void {
    const eventId = item.event_id;
    if (!eventId) return;
    void core.reportMessage(roomId, eventId, reason).catch((error: unknown) => {
      console.warn('[sable timeline] report failed', error);
    });
  }

  function forward(toRoomId: string): void {
    const eventId = item.event_id;
    if (!eventId) return;
    void core.forwardMessage(roomId, eventId, toRoomId).catch((error: unknown) => {
      console.warn('[sable timeline] forward failed', error);
    });
  }

  const LONG_PRESS_MS = 450;
  const LONG_PRESS_SLOP_PX = 10;
  let sheetOpen = $state(false);
  let emoteOpen = $state(false);
  let sourceOpen = $state(false);
  let reportOpen = $state(false);
  let forwardOpen = $state(false);
  let source = $state('');
  let pinned = $state(false);
  let bookmarked = $state(false);

  $effect(() => {
    const eventId = item.event_id;
    if (!roomId || !eventId) return;
    void core
      .pinnedEvents(roomId)
      .then((ids) => (pinned = ids.includes(eventId)))
      .catch(() => undefined);
  });
  let deleteOpen = $state(false);
  let reactionsOpen = $state(false);
  let reactionActive = $state(0);
  let receiptsOpen = $state(false);
  let peekOpen = $state(false);
  let messageRow = $state<HTMLElement | null>(null);
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let pressOrigin: { x: number; y: number } | null = null;
  let touchInteraction = $state(false);
  let reactionPressTimer: ReturnType<typeof setTimeout> | undefined;
  let reactionPressOrigin: { x: number; y: number } | null = null;
  let reactionPressFired = false;

  function startPress(event: PointerEvent): void {
    touchInteraction = event.pointerType !== 'mouse';
    if (event.pointerType === 'mouse' || !actionable) return;
    pressOrigin = { x: event.clientX, y: event.clientY };
    pressTimer = setTimeout(() => {
      sheetOpen = true;
      pressOrigin = null;
    }, LONG_PRESS_MS);
  }

  function suppressTouchContextMenu(event: MouseEvent): void {
    if (!touchInteraction) return;
    event.preventDefault();
  }

  function movePress(event: PointerEvent): void {
    if (!pressOrigin) return;
    const moved =
      Math.abs(event.clientX - pressOrigin.x) > LONG_PRESS_SLOP_PX ||
      Math.abs(event.clientY - pressOrigin.y) > LONG_PRESS_SLOP_PX;
    if (moved) endPress();
  }

  $effect(() => {
    if (sheetOpen) openMessageMenu.set(item.id, false);
  });

  function endPress(): void {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = undefined;
    pressOrigin = null;
  }

  function startReactionPress(event: PointerEvent, index: number): void {
    if (event.pointerType === 'mouse') return;
    event.stopPropagation();
    reactionPressFired = false;
    reactionPressOrigin = { x: event.clientX, y: event.clientY };
    reactionPressTimer = setTimeout(() => {
      reactionPressTimer = undefined;
      reactionPressFired = true;
      reactionActive = index;
      reactionsOpen = true;
    }, LONG_PRESS_MS);
  }

  function moveReactionPress(event: PointerEvent): void {
    event.stopPropagation();
    if (!reactionPressOrigin) return;
    const moved =
      Math.abs(event.clientX - reactionPressOrigin.x) > LONG_PRESS_SLOP_PX ||
      Math.abs(event.clientY - reactionPressOrigin.y) > LONG_PRESS_SLOP_PX;
    if (moved) endReactionPress();
  }

  function endReactionPress(event?: PointerEvent): void {
    event?.stopPropagation();
    if (reactionPressTimer) clearTimeout(reactionPressTimer);
    reactionPressTimer = undefined;
    reactionPressOrigin = null;
  }

  function openReactionDetails(event: MouseEvent, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    reactionActive = index;
    reactionsOpen = true;
  }

  // A virtualised row can unmount mid-press, so the pending timer has to go.
  onDestroy(() => {
    if (pressTimer) clearTimeout(pressTimer);
    if (reactionPressTimer) clearTimeout(reactionPressTimer);
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

  function reactionTooltip(senders: readonly string[], key: string): string {
    const names = senders.map(
      (sender) => members.find((member) => member.user_id === sender)?.display_name ?? sender
    );
    const people =
      names.length === 1
        ? names[0]
        : names.length === 2
          ? `${names[0]} and ${names[1]}`
          : names.length === 3
            ? `${names[0]}, ${names[1]}, and ${names[2]}`
            : `${names.slice(0, 3).join(', ')}, and ${String(names.length - 3)} others`;
    return `${people} reacted with ${key}`;
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
    <ContextMenu.Trigger disabled={!actionable || touchInteraction}>
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
        onpointerdown={startPress}
        onpointermove={movePress}
        onpointerup={endPress}
        onpointercancel={endPress}
        oncontextmenu={suppressTouchContextMenu}
      >
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
                initials={initials(senderName)}
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
                initials={initials(senderName)}
              />
            </button>
          {:else}
            <Avatar
              class="message-avatar"
              src={senderAvatar}
              size="small"
              color={senderAvatar ? undefined : avatarColor}
              initials={initials(senderName)}
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
              {#if persona && item.sender}
                {@const account = item.sender}
                <button
                  class="via"
                  type="button"
                  aria-label={$i18n.t('timeline.viaAccount', { user: accountName })}
                  onclick={openSenderProfile}
                >
                  {$i18n.t('timeline.via')}<strong>{account}</strong>
                </button>
              {/if}
              <time datetime={new Date(item.timestamp).toISOString()}
                >{formatTime(item.timestamp)}</time
              >
            </header>
          {/if}
          {#if item.in_reply_to}
            {@const tint = tinted(replyPersona)}
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
            {@const eventId = item.event_id}
            <BitsTooltip.Provider delayDuration={400} skipDelayDuration={100}>
              <div class="reactions" aria-label={$i18n.t('timeline.reactions')}>
                {#each item.reactions as reaction, index (reaction.key)}
                  {@const mine = currentUserId !== null && reaction.senders.includes(currentUserId)}
                  {#snippet reactionTrigger({ props }: { props: Record<string, unknown> })}
                    <button
                      {...props}
                      class={['reaction', { mine }]}
                      type="button"
                      aria-pressed={mine}
                      aria-label={$i18n.t('timeline.toggleReaction', {
                        key: reaction.key,
                        count: reaction.senders.length,
                      })}
                      disabled={eventId === null}
                      onclick={() => {
                        if (reactionPressFired) {
                          reactionPressFired = false;
                          return;
                        }
                        if (eventId) onToggleReaction?.(eventId, reaction.key);
                      }}
                      oncontextmenu={(event) => {
                        openReactionDetails(event, index);
                      }}
                      onpointerdown={(event) => {
                        startReactionPress(event, index);
                      }}
                      onpointermove={moveReactionPress}
                      onpointerup={endReactionPress}
                      onpointercancel={endReactionPress}
                    >
                      {#if reaction.key.startsWith('mxc://')}
                        <MediaImage
                          class="reaction-image"
                          source={reaction.key}
                          alt={reaction.key}
                          width={64}
                          height={64}
                        />
                      {:else}
                        <em>{reaction.key}</em>
                      {/if}
                      {reaction.senders.length}
                    </button>
                  {/snippet}
                  <BitsTooltip.Root>
                    <BitsTooltip.Trigger child={reactionTrigger} />
                    <BitsTooltip.Portal>
                      <BitsTooltip.Content
                        class="reaction-tooltip"
                        side="top"
                        align="center"
                        sideOffset={8}
                      >
                        {reactionTooltip(reaction.senders, reaction.key)}
                      </BitsTooltip.Content>
                    </BitsTooltip.Portal>
                  </BitsTooltip.Root>
                {/each}
                {#if actionable && actions.onReact}
                  {@const react = actions.onReact}
                  <ReactionPicker
                    label={$i18n.t('timeline.addReaction')}
                    triggerClass="add-reaction"
                    {roomId}
                    onPick={react}
                  >
                    <PlusIcon />
                  </ReactionPicker>
                {/if}
              </div>
            </BitsTooltip.Provider>
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
{:else if item.content.kind === 'membership' || item.content.kind === 'profile_change' || (item.content.kind === 'state_event' && item.content.change !== null)}
  <p class="state">
    <span class="state-rail" aria-hidden="true"></span>
    <StateEventText {item} {onSenderProfile} />
  </p>
{:else if item.content.kind === 'state_event' || item.content.kind === 'hidden_event'}
  {@const raw = item.content.content}
  <div class="debug-event">
    <code>{item.content.event_type}</code>
    <div class="debug-body">
      <span><StateEventText {item} {onSenderProfile} /></span>
      {#if raw !== null}
        <Collapsible.Root bind:open={peekOpen}>
          <Collapsible.Trigger class="debug-peek-trigger">
            {peekOpen ? $i18n.t('timeline.hidePeek') : $i18n.t('timeline.showPeek')}
          </Collapsible.Trigger>
          <Collapsible.Content>
            <pre class="debug-peek">{JSON.stringify(raw, null, 2)}</pre>
          </Collapsible.Content>
        </Collapsible.Root>
      {/if}
    </div>
  </div>
{:else if item.content.kind === 'unable_to_decrypt'}
  <p class="undecryptable">
    {$i18n.t('timeline.unableToDecrypt', { reason: item.content.reason })}
  </p>
{:else if item.content.kind === 'unsupported'}
  <p class="state">
    <span class="state-rail" aria-hidden="true"></span>
    {$i18n.t('timeline.unsupported', { description: item.content.description })}
  </p>
{:else if item.content.kind === 'date_divider'}
  <p class="date-divider"><span>{formatDate(item.content.timestamp)}</span></p>
{:else if item.content.kind === 'timeline_start'}
  <p class="separator">{$i18n.t('timeline.start')}</p>
{:else if item.content.kind === 'read_marker'}
  {#if unreadCount > 0}
    <p class="unread">
      <span>{$i18n.t('timeline.unreadCount', { count: unreadCount })}</span>
    </p>
  {:else}
    <p class="read-marker"><span>{$i18n.t('timeline.readMarker')}</span></p>
  {/if}
{:else}
  <p class="state redacted">
    <span class="state-rail" aria-hidden="true"></span>
    <span class="redacted-label">{$i18n.t('timeline.redacted')}</span>
  </p>
{/if}

<style>
  .message {
    display: flex;
    gap: var(--timeline-row-gap);
    overflow-wrap: anywhere;
    padding: var(--timeline-row-padding) 0;
    position: relative;
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
    align-items: center;
    background: var(--sable-surface-var-container);
    border: var(--border-width) solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-normal);
    gap: var(--space-100);
    letter-spacing: 0.01em;
    padding: 0 var(--space-1);
    position: relative;
  }

  .via:hover {
    background: var(--sable-surface-var-container-hover);
  }

  .via::after {
    content: '';
    inset: -0.5rem -2px;
    position: absolute;
  }

  .via strong {
    font-weight: var(--font-weight-medium);
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
    font-size: var(--font-size-small);
  }

  .edited {
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
  .reply-preview,
  .separator,
  .unread,
  .date-divider,
  .state,
  .debug-event,
  .undecryptable {
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
  .reactions :global(.add-reaction) {
    align-items: center;
    background: var(--sable-surface-var-container);
    border: var(--border-width) solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    justify-content: center;
    min-height: 1.5rem;
    padding: 2px var(--space-200);
  }

  .reaction {
    align-items: center;
    background: var(--sable-surface-var-container);
    border: var(--border-width) solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    font-weight: var(--font-weight-medium);
    gap: var(--space-100);
    min-height: 1.5rem;
    padding: 2px var(--space-200) 2px var(--space-150);
    position: relative;
  }

  .reaction::after {
    border-radius: inherit;
    content: '';
    inset: -0.375rem -2px;
    position: absolute;
  }

  .reaction :global(.reaction-image) {
    display: block;
    height: 1.125rem;
    object-fit: contain;
    width: auto;
  }

  .reaction em {
    font-size: var(--font-size-body);
    font-style: normal;
    line-height: 1;
  }

  .reaction.mine {
    background: var(--sable-primary-container);
    border-color: var(--sable-primary-container-line);
    color: var(--sable-primary-on-container);
  }

  .reaction:disabled {
    cursor: default;
  }

  .reaction:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

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

  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
    margin-top: var(--space-150);
  }

  .separator {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    padding: var(--space-200);
    text-align: center;
  }

  .state {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    line-height: 1.3;
    padding: 0;
  }

  .state-rail {
    border-top: var(--border-width) dashed var(--sable-surface-var-container-line);
    flex: 0 0 calc(var(--avatar-size-small) - 0.75rem);
    margin-inline-start: var(--space-300);
  }

  .redacted-label {
    align-items: center;
    border: var(--border-width) dashed var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    display: inline-flex;
    gap: var(--space-100);
    padding: var(--space-hairline) var(--space-1);
  }

  .debug-event {
    align-items: baseline;
    background: var(--sable-surface-var-container);
    border-block: var(--border-width) dashed var(--sable-surface-var-container-line);
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    padding: var(--space-150) 0;
  }

  .debug-body {
    display: grid;
    gap: var(--space-hairline);
    min-width: 0;
  }

  .debug-body :global(.debug-peek-trigger) {
    background: none;
    border: 0;
    color: var(--sable-primary-main);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    justify-self: start;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .debug-peek {
    background: var(--sable-bg-container);
    border-radius: var(--radius);
    font-size: var(--font-size-small);
    margin: var(--space-100) 0 0;
    max-height: 14rem;
    overflow: auto;
    padding: var(--space-1);
  }

  .debug-event code {
    flex: 0 0 auto;
    font-family: var(--font-family-mono);
    margin-inline-start: calc(var(--avatar-size-small) + var(--space-250));
  }

  .undecryptable {
    background: var(--sable-surface-var-container);
    border: var(--border-width) dashed var(--sable-surface-var-container-line);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin-inline-start: calc(var(--avatar-size-small) + var(--space-250));
    max-width: 32rem;
    padding: var(--space-150) var(--space-200);
    width: fit-content;
  }

  .date-divider {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-300);
    padding: var(--space-300) 0;
    text-align: center;
  }

  .date-divider::before,
  .date-divider::after {
    border-top: var(--border-width) solid var(--sable-bg-container-line);
    content: '';
    flex: 1;
  }

  .date-divider span {
    background: var(--sable-surface-var-container);
    border: var(--border-width) solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.06em;
    padding: var(--space-hairline) var(--space-2);
    text-transform: uppercase;
  }

  .unread,
  .read-marker {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    margin: 0;
    padding: var(--space-100) 0;
  }

  .read-marker::before {
    border-top: var(--border-width) solid var(--sable-success-main);
    content: '';
    flex: 1;
  }

  .read-marker span {
    color: var(--sable-success-main);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .unread::before {
    border-top: calc(var(--border-width) * 2) solid var(--sable-primary-main-line);
    content: '';
    flex: 1;
  }

  .unread span {
    background: var(--sable-primary-container);
    border: var(--border-width) solid var(--sable-primary-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-primary-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.04em;
    padding: var(--space-hairline) var(--space-200);
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
