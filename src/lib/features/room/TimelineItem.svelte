<script lang="ts">
  import type { TimelineItemView } from '@/generated/TimelineItemView';

  import { i18n } from '$lib/i18n';
  import Avatar from '$lib/ui/primitives/Avatar.svelte';
  import MediaImage from '$lib/ui/MediaImage.svelte';
  import MediaContent from '$lib/ui/MediaContent.svelte';

  import FormattedBody from './FormattedBody.svelte';
  import type { MatrixLink } from './matrix-link';
  import { formatDate, formatTime, initials, senderColor } from './timeline-format';

  interface Props {
    item: TimelineItemView;
    collapsed: boolean;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
    onRetrySend?: (transactionId: string) => void;
    onCancelSend?: (transactionId: string) => void;
    currentUserId?: string | null;
    onToggleReaction?: (eventId: string, key: string) => void;
  }

  let {
    item,
    collapsed,
    onMatrixLink,
    onSenderProfile,
    onRetrySend,
    onCancelSend,
    currentUserId = null,
    onToggleReaction,
  }: Props = $props();
  let senderName = $derived(item.sender_name ?? item.sender ?? $i18n.t('timeline.unknownSender'));
  let emote = $derived(item.content.kind === 'message' && item.content.emote);
  // A recoverable failure resumes by itself, so only a parked one gets a prompt.
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

  function openSenderProfile(event: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    if (item.sender) onSenderProfile?.(item.sender, event.currentTarget);
  }

  /** A single event can rename, unset a name, or change the avatar. */
  function profileChangeText(
    change: Extract<TimelineItemView['content'], { kind: 'profile_change' }>
  ): string {
    const user = change.display_name?.old ?? change.user_id;
    if (change.display_name?.new) {
      const key = change.display_name.old ? 'profileNameChanged' : 'profileNameSet';
      return $i18n.t(`timeline.${key}`, { user, name: change.display_name.new });
    }
    if (change.display_name) return $i18n.t('timeline.profileNameRemoved', { user });
    return $i18n.t('timeline.profileAvatarChanged', { user });
  }
</script>

{#if item.content.kind === 'message' || item.content.kind === 'image' || item.content.kind === 'video' || item.content.kind === 'audio' || item.content.kind === 'file' || item.content.kind === 'sticker'}
  <article class={['message', { collapsed, stalled: stalled !== null, pending }]}>
    {#if !collapsed}
      {#if item.sender && onSenderProfile}
        <button
          class="avatar-button"
          type="button"
          aria-label={$i18n.t('timeline.senderProfile', { name: senderName })}
          onclick={openSenderProfile}
        >
          <Avatar
            class="message-avatar"
            src={item.sender_avatar}
            size="small"
            color={senderColor(item.sender)}
            initials={initials(senderName)}
          />
        </button>
      {:else}
        <Avatar
          class="message-avatar"
          src={item.sender_avatar}
          size="small"
          color={senderColor(item.sender)}
          initials={initials(senderName)}
        />
      {/if}
    {/if}
    <div class="message-content">
      {#if !collapsed}
        <header>
          <!-- An emote carries the name in its own text, so the header omits it. -->
          {#if !emote}
            <span class="sender" style:color={senderColor(item.sender)}>{senderName}</span>
          {/if}
          <time datetime={new Date(item.timestamp).toISOString()}>{formatTime(item.timestamp)}</time
          >
          {#if item.content.kind === 'message' && item.content.edited}
            <span class="edited">{$i18n.t('timeline.edited')}</span>
          {/if}
        </header>
      {/if}
      {#if item.in_reply_to}
        <p class="reply-preview">
          <strong
            >{item.in_reply_to.sender_name ??
              item.in_reply_to.sender ??
              $i18n.t('timeline.unknownSender')}</strong
          >
          {item.in_reply_to.body ?? ''}
        </p>
      {/if}
      {#if item.content.kind === 'message' && item.content.emote}
        <div class="emote">
          <span class="sender" style:color={senderColor(item.sender)}>* {senderName}</span>
          <FormattedBody html={item.content.html} {onMatrixLink} />
        </div>
      {:else if item.content.kind === 'message'}
        <FormattedBody html={item.content.html} {onMatrixLink} />
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
        {#if item.content.body}<p class="body">{item.content.body}</p>{/if}
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
              <em>{reaction.key}</em>
              {reaction.senders.length}
            </button>
          {/each}
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
          <!-- The raw SDK error is diagnostic detail. -->
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
{:else if item.content.kind === 'membership'}
  <p class="separator">
    {$i18n.t(`timeline.membership.${item.content.change}`, {
      user: item.content.display_name ?? item.content.user_id,
    })}
  </p>
{:else if item.content.kind === 'profile_change'}
  <p class="separator">{profileChangeText(item.content)}</p>
{:else if item.content.kind === 'state_event'}
  <p class="separator">
    {$i18n.t('timeline.stateEvent', { type: item.content.event_type })}
  </p>
{:else if item.content.kind === 'unable_to_decrypt'}
  <p class="separator">{$i18n.t('timeline.unableToDecrypt', { reason: item.content.reason })}</p>
{:else if item.content.kind === 'unsupported'}
  <p class="separator">
    {$i18n.t('timeline.unsupported', { description: item.content.description })}
  </p>
{:else if item.content.kind === 'date_divider'}
  <p class="date-divider"><span>{formatDate(item.content.timestamp)}</span></p>
{:else if item.content.kind === 'timeline_start'}
  <p class="separator">{$i18n.t('timeline.start')}</p>
{:else if item.content.kind === 'read_marker'}
  <p class="read-marker">{$i18n.t('timeline.readMarker')}</p>
{:else}
  <p class="separator">{$i18n.t('timeline.redacted')}</p>
{/if}

<style>
  .message {
    display: flex;
    gap: 0.625rem;
    overflow-wrap: anywhere;
    padding: 0.25rem 0;
  }

  .message.collapsed {
    padding-left: calc(var(--avatar-size-small) + 0.625rem);
  }

  .message.pending {
    opacity: 0.65;
  }

  /* Filling the row would make one failure the loudest thing on screen, and
     would grow with the message. */
  .message.stalled {
    box-shadow: inset 2px 0 0 var(--sable-crit-main);
  }

  @media (width >= 48rem) and (hover: hover) and (pointer: fine) {
    .message {
      margin-inline: calc(-1 * var(--page-gutter));
      padding-inline: var(--page-gutter);
    }

    .message.collapsed {
      padding-left: calc(var(--page-gutter) + var(--avatar-size-small) + 0.625rem);
    }

    .message:hover {
      background-color: var(--sable-surface-container-hover);
    }
  }

  :global(.sable-avatar.message-avatar) {
    color: var(--sable-primary-on-main);
  }

  .avatar-button {
    background: none;
    border: 0;
    border-radius: var(--radius-pill);
    cursor: pointer;
    display: block;
    flex: 0 0 auto;
    height: var(--avatar-size-small);
    padding: 0;
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
  }

  /* An emote reads as one sentence, so the name sits in the text flow. */
  .emote {
    font-style: italic;
    line-height: var(--line-height-body);
  }

  .emote :global(.formatted-body) {
    display: inline;
  }

  time,
  .edited {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
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
  .read-marker,
  .date-divider {
    margin: 0;
  }

  .body {
    line-height: var(--line-height-body);
    white-space: pre-wrap;
  }

  /* The third term is the width a 32rem-tall image would take: it caps height
     without letterboxing a portrait picture. */
  :global(.image) {
    border-radius: var(--radius);
    display: block;
    margin-top: 0.25rem;
    width: min(100%, 32rem, calc(32rem * var(--media-ratio)));
  }

  /* A sticker is glyph-sized, so it ignores the picture box width. */
  :global(.sticker) {
    border-radius: var(--radius);
    display: block;
    margin-top: 0.25rem;
    width: 9.5rem;
  }

  :global(.media) {
    width: min(100%, 32rem);
  }

  .reply-preview {
    background: var(--sable-surface-var-container);
    border: 1px solid var(--sable-surface-var-container-line);
    border-inline-start: 3px solid var(--sable-primary-main-line);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: 1.4;
    margin-bottom: 0.25rem;
    overflow: hidden;
    padding: 0.25rem 0.5rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reply-preview strong {
    color: var(--sable-sec-on-container);
    margin-right: 0.25rem;
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

    /* Sits the glyph nearer the leading edge than the count. */
    padding: 2px 0.5rem 2px 0.375rem;
    position: relative;
  }

  /* Keeps the pill visually 24px while meeting the 36px touch target. */
  .reaction::after {
    border-radius: inherit;
    content: '';
    inset: -0.375rem -2px;
    position: absolute;
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
    background: var(--sable-surface-var-container);
    content: '';
    flex: 1;
    height: 1px;
  }

  .date-divider span {
    background: var(--sable-surface-var-container);
    border-radius: 999px;
    padding: 0.125rem 0.625rem;
  }

  .read-marker {
    border-bottom: 1px solid var(--sable-success-main);
    color: var(--sable-success-main);
    font-size: var(--font-size-small);
    padding: 0.25rem 0;
    text-align: center;
  }
</style>
