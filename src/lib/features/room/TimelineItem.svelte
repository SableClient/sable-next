<script lang="ts">
  import type { TimelineItemView } from '@/generated/TimelineItemView';

  import { i18n } from '$lib/i18n';
  import StatusBadge from '$lib/ui/primitives/StatusBadge.svelte';
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
  }

  let { item, collapsed, onMatrixLink }: Props = $props();
</script>

{#if item.content.kind === 'message' || item.content.kind === 'image' || item.content.kind === 'video' || item.content.kind === 'audio' || item.content.kind === 'file' || item.content.kind === 'sticker'}
  <article
    class={[
      'message',
      {
        collapsed,
        failed: item.send_state?.status === 'failed',
        sending: item.send_state?.status === 'sending',
      },
    ]}
  >
    {#if !collapsed}
      <Avatar
        class="message-avatar"
        src={item.sender_avatar}
        size="small"
        color={senderColor(item.sender)}
        initials={initials(item.sender_name ?? item.sender ?? $i18n.t('timeline.unknownSender'))}
      />
    {/if}
    <div class="message-content">
      {#if !collapsed}
        <header>
          <span class="sender" style:color={senderColor(item.sender)}
            >{item.sender_name ?? item.sender ?? $i18n.t('timeline.unknownSender')}</span
          >
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
      {#if item.content.kind === 'message'}
        <FormattedBody body={item.content.body} formatted={item.content.formatted} {onMatrixLink} />
      {:else if item.content.kind === 'image' || item.content.kind === 'sticker'}
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
        />
      {/if}
      {#if item.reactions.length > 0}
        <div class="reactions" aria-label={$i18n.t('timeline.reactions')}>
          {#each item.reactions as reaction (reaction.key)}
            <StatusBadge
              label={reaction.key + ' ' + reaction.senders.length.toString()}
              variant="neutral"
            />
          {/each}
        </div>
      {/if}
      {#if item.send_state?.status === 'sending'}
        <span class="send-state">{$i18n.t('timeline.sending')}</span>
      {:else if item.send_state?.status === 'failed'}
        <span class="send-state">{$i18n.t('timeline.sendFailed')}: {item.send_state.error}</span>
      {/if}
    </div>
  </article>
{:else if item.content.kind === 'membership'}
  <p class="separator">
    {$i18n.t('timeline.membership', { user: item.content.user_id, change: item.content.change })}
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

  .message.sending {
    opacity: 0.65;
  }

  .message.failed {
    background: var(--sable-crit-container);
    border-radius: var(--radius);
    color: var(--sable-crit-on-container);
    padding: 0.5rem;
  }

  @media (width >= 48rem) and (hover: hover) and (pointer: fine) {
    .message {
      margin-inline: calc(-1 * var(--page-gutter));
      padding-inline: var(--page-gutter);
    }

    .message.failed {
      padding-inline: var(--page-gutter);
    }

    .message.collapsed {
      padding-left: calc(var(--page-gutter) + var(--avatar-size-small) + 0.625rem);
    }

    .message:hover {
      background-color: var(--sable-surface-container-hover);
    }

    .message.failed:hover {
      background-color: var(--sable-crit-container-hover);
    }
  }

  :global(.sable-avatar.message-avatar) {
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
  }

  time,
  .edited,
  .send-state {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .failed .send-state {
    color: var(--sable-crit-on-container);
    display: block;
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

  :global(.image) {
    border-radius: var(--radius);
    display: block;
    margin-top: 0.25rem;
    max-height: 32rem;
    object-fit: contain;
    width: min(100%, 32rem);
  }

  :global(.media) {
    width: min(100%, 32rem);
  }

  .reply-preview {
    border-left: 2px solid var(--sable-primary-main);
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin-bottom: 0.25rem;
    overflow: hidden;
    padding-left: 0.5rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reply-preview strong {
    color: var(--sable-bg-on-container);
    margin-right: 0.25rem;
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
