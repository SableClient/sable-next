<script lang="ts">
  import { Collapsible } from 'bits-ui';

  import type { MemberView } from '@/generated/MemberView';
  import type { PerMessageProfileView } from '@/generated/PerMessageProfileView';
  import type { TimelineItemView } from '@/generated/TimelineItemView';

  import { i18n } from '$lib/i18n';
  import type { TimelineLayout } from '$lib/settings/preferences.svelte';
  import Avatar from '$lib/ui/primitives/Avatar.svelte';
  import MediaImage from '$lib/ui/MediaImage.svelte';
  import MediaContent from '$lib/ui/MediaContent.svelte';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';

  import FormattedBody from './FormattedBody.svelte';
  import MessageActions from './MessageActions.svelte';
  import MessageActionSheet from './MessageActionSheet.svelte';
  import PersonaProfile from './PersonaProfile.svelte';
  import ReactionPicker from './ReactionPicker.svelte';
  import ReactionsDialog from './ReactionsDialog.svelte';
  import ReceiptsDialog from './ReceiptsDialog.svelte';
  import DeleteMessageDialog from './DeleteMessageDialog.svelte';
  import type { MatrixLink } from './matrix-link';
  import { stateEventText } from './state-event-text';
  import './avatar-button.css';
  import {
    formatDate,
    formatTime,
    initials,
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
    onEdit?: (eventId: string, body: string) => void;
    onDelete?: (eventId: string, reason: string | null) => void;
    onCopyLink?: (eventId: string) => void;
    canRedactOthers?: boolean;
    selected?: boolean;
    layout?: TimelineLayout;
    members?: readonly MemberView[];
    onJumpToEvent?: (eventId: string) => void;
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
    onPersonaOpenChange,
  }: Props = $props();
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
  let ownMessage = $derived(item.is_own && item.content.kind === 'message');
  let avatarColor = $derived(personaTint || item.is_own ? undefined : senderColor(item.sender));
  let nameColor = $derived(
    item.is_own ? 'var(--sable-primary-on-container)' : senderColor(item.sender)
  );

  let actions = $derived.by(() => {
    const eventId = item.event_id ?? '';
    const body = item.content.kind === 'message' ? item.content.body : null;
    return {
      onReact: onToggleReaction
        ? (emoji: string) => {
            onToggleReaction(eventId, emoji);
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
        ownMessage && onEdit && body !== null
          ? () => {
              onEdit(eventId, body);
            }
          : undefined,
      onDelete:
        (ownMessage || canRedactOthers) && onDelete
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
    };
  });

  const LONG_PRESS_MS = 450;
  const LONG_PRESS_SLOP_PX = 10;
  let sheetOpen = $state(false);
  let deleteOpen = $state(false);
  let reactionsOpen = $state(false);
  let receiptsOpen = $state(false);
  let peekOpen = $state(false);
  let messageRow = $state<HTMLElement | null>(null);
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let pressOrigin: { x: number; y: number } | null = null;

  function startPress(event: PointerEvent): void {
    if (event.pointerType === 'mouse' || !actionable) return;
    pressOrigin = { x: event.clientX, y: event.clientY };
    pressTimer = setTimeout(() => {
      sheetOpen = true;
      pressOrigin = null;
    }, LONG_PRESS_MS);
  }

  function movePress(event: PointerEvent): void {
    if (!pressOrigin) return;
    const moved =
      Math.abs(event.clientX - pressOrigin.x) > LONG_PRESS_SLOP_PX ||
      Math.abs(event.clientY - pressOrigin.y) > LONG_PRESS_SLOP_PX;
    if (moved) endPress();
  }

  function endPress(): void {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = undefined;
    pressOrigin = null;
  }

  // A virtualised row can unmount mid-press, so the pending timer has to go.
  $effect(() => endPress);

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

{#if item.content.kind === 'message' || item.content.kind === 'image' || item.content.kind === 'video' || item.content.kind === 'audio' || item.content.kind === 'file' || item.content.kind === 'sticker'}
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
    onpointerdown={startPress}
    onpointermove={movePress}
    onpointerup={endPress}
    onpointercancel={endPress}
  >
    {#if actionable}
      <MessageActions {roomId} onPickerOpenChange={onPersonaOpenChange} {...actions} />
      <MessageActionSheet
        bind:open={sheetOpen}
        preview={item.content.kind === 'message' ? item.content.body : null}
        {...actions}
      />
      <DeleteMessageDialog
        bind:open={deleteOpen}
        preview={item.content.kind === 'message' ? item.content.body : null}
        onConfirm={confirmDelete}
      />
      <ReactionsDialog bind:open={reactionsOpen} reactions={item.reactions} {members} />
      <ReceiptsDialog bind:open={receiptsOpen} readers={item.read_by} {members} />
    {/if}
    {#if layout === 'compact'}
      <div class="compact-gutter">
        <time datetime={new Date(item.timestamp).toISOString()}>{formatTime(item.timestamp)}</time>
        <span class="compact-name" style:color={personaTint ? undefined : nameColor}>
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
            color={avatarColor}
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
            color={avatarColor}
            initials={initials(senderName)}
          />
        </button>
      {:else}
        <Avatar
          class="message-avatar"
          src={senderAvatar}
          size="small"
          color={avatarColor}
          initials={initials(senderName)}
        />
      {/if}
    {/if}
    <div class="message-content">
      {#if !collapsed && layout !== 'compact'}
        <header>
          {#if !emote}
            <span class="sender" style:color={personaTint ? undefined : nameColor}>
              {senderName}
            </span>
          {/if}
          {#each persona?.pronouns ?? [] as pronoun (pronoun.summary)}
            <span class="pronouns" lang={pronoun.language ?? undefined}>{pronoun.summary}</span>
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
          <time datetime={new Date(item.timestamp).toISOString()}>{formatTime(item.timestamp)}</time
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
          <span class="sender" style:color={nameColor}>* {senderName}</span>
          <FormattedBody html={item.content.html} {onMatrixLink} />
        </div>
      {:else if item.content.kind === 'message'}
        <div class={jumbo === null ? undefined : `jumbo jumbo-${String(jumbo)}`}>
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
        />
        {#if isCaption(item.content.body)}<p class="body">{item.content.body}</p>{/if}
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
        <div class="reactions" aria-label={$i18n.t('timeline.reactions')}>
          {#each item.reactions as reaction (reaction.key)}
            {@const mine = currentUserId !== null && reaction.senders.includes(currentUserId)}
            <button
              class={['reaction', { mine }]}
              type="button"
              aria-pressed={mine}
              aria-label={$i18n.t('timeline.toggleReaction', {
                key: reaction.key,
                count: reaction.senders.length,
              })}
              disabled={eventId === null}
              onclick={() => {
                if (eventId) onToggleReaction?.(eventId, reaction.key);
              }}
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
            <button type="button" onclick={() => onRetrySend?.(transactionId)}>
              {$i18n.t('timeline.retrySend')}
            </button>
            <button type="button" onclick={() => onCancelSend?.(transactionId)}>
              {$i18n.t('timeline.cancelSend')}
            </button>
          {/if}
        </p>
      {/if}
    </div>
  </article>
{:else if item.content.kind === 'membership' || item.content.kind === 'profile_change'}
  <p class="state">
    <span class="state-rail" aria-hidden="true"></span>
    {stateEventText(item, $i18n.t)}
  </p>
{:else if item.content.kind === 'state_event'}
  {@const raw = item.content.content}
  <div class="debug-event">
    <code>{item.content.event_type}</code>
    <div class="debug-body">
      <span>{$i18n.t('timeline.stateEvent', { type: item.content.event_type })}</span>
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
    border-inline-start: 4px solid;
    border-radius: 0 var(--radius) var(--radius) 0;
    padding-inline: 0.5rem;
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
    box-shadow: inset 0 0 0 1px var(--sable-primary-container-line);
  }

  .message.collapsed {
    padding-left: calc(var(--avatar-size-small) + var(--timeline-row-gap));
  }

  /* Identity has to persist when the header is gone. */
  .message.persona.collapsed::before {
    background: color-mix(in oklab, var(--pmp-ink) 55%, var(--sable-bg-container-line));
    border-radius: var(--radius-pill);
    content: '';
    inset-block: 2px;
    inset-inline-start: calc(var(--avatar-size-small) / 2 - 1px);
    position: absolute;
    width: 2px;
  }

  .message.pending {
    opacity: 0.65;
  }

  .message.highlighted {
    border-radius: var(--radius);
  }

  .jumbo-1 {
    font-size: 2.4rem;
    line-height: 1.15;
  }

  .jumbo-2 {
    font-size: 1.9rem;
    line-height: 1.2;
  }

  .jumbo-3 {
    font-size: 1.5rem;
    line-height: 1.3;
  }

  .jumbo-4 {
    font-size: 1.25rem;
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
      animation: jump 6s var(--motion-easing-standard) infinite;
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
    gap: 0.5rem;
  }

  .sender {
    font-weight: var(--font-weight-bold);
    letter-spacing: -0.005em;
    max-width: 24ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .persona {
    --pmp-ink: var(--pmp-on-light, var(--sable-sec-on-container));
  }

  @media (prefers-color-scheme: dark) {
    .persona {
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
      .persona {
        --pmp-ink: oklch(
          from var(--pmp-on-dark, var(--sable-sec-on-container)) clamp(0.72, l, 0.92)
            clamp(0, c, 0.16) h
        );
      }
    }
  }

  .message.persona :global(.message-avatar) {
    background: color-mix(in oklab, var(--pmp-ink) 18%, var(--sable-surface-var-container));
    color: var(--pmp-ink);
  }

  .pronouns {
    background: var(--sable-surface-var-container);
    border: 1px solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    letter-spacing: 0.015em;
    line-height: 1.35;
    padding: 0 var(--space-1);
    text-transform: lowercase;
  }

  .via {
    align-items: center;
    background: var(--sable-surface-var-container);
    border: 1px solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-normal);
    gap: 0.25rem;
    letter-spacing: 0.01em;
    padding: 0 var(--space-1);
    position: relative;
    transition: background-color 120ms ease-out;
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
    margin-inline-start: 0.25rem;
  }

  .send-failure {
    align-items: baseline;
    color: var(--sable-crit-main);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    margin-top: 0.125rem;
  }

  .send-failure button {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 0.15em;
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
    margin-top: 0.25rem;
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
    margin-top: 0.25rem;
    width: min(
      100%,
      var(--timeline-media-max),
      calc(var(--timeline-media-max) * var(--media-ratio))
    );
  }

  :global(.sticker) {
    border-radius: var(--radius);
    display: block;
    margin-top: 0.25rem;
    width: var(--timeline-sticker-width);
  }

  :global(.media) {
    width: min(100%, var(--timeline-media-max));
  }

  .reply-preview {
    align-items: center;
    background: var(--sable-surface-var-container);
    border: 1px solid var(--sable-surface-var-container-line);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: grid;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-1);
    grid-template-columns: auto minmax(0, 1fr);
    line-height: 1.4;
    margin-bottom: 0.25rem;
    padding: 0.25rem var(--space-1);
    text-align: start;
    width: 100%;
  }

  .reply-preview:hover {
    background: var(--sable-surface-var-container-hover);
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
    border: 1px solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    justify-content: center;
    min-height: 1.5rem;
    padding: 2px 0.5rem;
  }

  .reaction {
    align-items: center;
    background: var(--sable-surface-var-container);
    border: 1px solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    font-weight: var(--font-weight-medium);
    gap: 0.25rem;
    min-height: 1.5rem;
    padding: 2px 0.5rem 2px 0.375rem;
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

  @media (prefers-reduced-motion: no-preference) {
    .reaction {
      transition:
        background-color var(--motion-normal) var(--motion-easing-standard),
        border-color var(--motion-normal) var(--motion-easing-standard);
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
    gap: 0.25rem;
    margin-top: 0.375rem;
  }

  .separator {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    padding: 0.5rem;
    text-align: center;
  }

  .state {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    line-height: 1.3;
    padding: 0;
  }

  .state-rail {
    border-top: 1px dashed var(--sable-surface-var-container-line);
    flex: 0 0 calc(var(--avatar-size-small) - 0.75rem);
    margin-inline-start: 0.75rem;
  }

  .redacted-label {
    align-items: center;
    border: 1px dashed var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    display: inline-flex;
    gap: 0.25rem;
    padding: 0.125rem var(--space-1);
  }

  .debug-event {
    align-items: baseline;
    background: var(--sable-surface-var-container);
    border-block: 1px dashed var(--sable-surface-var-container-line);
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    padding: 0.375rem 0;
  }

  .debug-body {
    display: grid;
    gap: 0.125rem;
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
    margin: 0.25rem 0 0;
    max-height: 14rem;
    overflow: auto;
    padding: var(--space-1);
  }

  .debug-event code {
    flex: 0 0 auto;
    font-family: var(--font-family-mono);
    margin-inline-start: calc(var(--avatar-size-small) + 0.625rem);
  }

  .undecryptable {
    background: var(--sable-surface-var-container);
    border: 1px dashed var(--sable-surface-var-container-line);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin-inline-start: calc(var(--avatar-size-small) + 0.625rem);
    max-width: 32rem;
    padding: 0.375rem 0.5rem;
    width: fit-content;
  }

  .date-divider {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.75rem;
    padding: 0.75rem 0;
    text-align: center;
  }

  .date-divider::before,
  .date-divider::after {
    border-top: 1px solid var(--sable-bg-container-line);
    content: '';
    flex: 1;
  }

  .date-divider span {
    background: var(--sable-surface-var-container);
    border: 1px solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.06em;
    padding: 0.125rem var(--space-2);
    text-transform: uppercase;
  }

  .unread,
  .read-marker {
    align-items: center;
    display: flex;
    gap: 0.5rem;
    margin: 0;
    padding: 0.25rem 0;
  }

  .read-marker::before {
    border-top: 1px solid var(--sable-success-main);
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
    border-top: 2px solid var(--sable-primary-main-line);
    content: '';
    flex: 1;
  }

  .unread span {
    background: var(--sable-primary-container);
    border: 1px solid var(--sable-primary-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-primary-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.04em;
    padding: 0.125rem 0.5rem;
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
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius-card);
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
    padding-right: calc(var(--avatar-size-small) + 0.625rem);
  }
</style>
