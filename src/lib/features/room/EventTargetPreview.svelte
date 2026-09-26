<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import ArrowBendUpLeftIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';

  import type { MemberView, TimelineItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  import { readEventSource } from './event-source-cache';
  import { memberName } from './members.js';
  import { replyFallbackFromSource } from './reply-fallback';
  import { replyPreviewBody } from './reply-preview';
  import { reactionKey, stateEventText, type Translate } from './state-event-text';
  import type { TimelineEventIndex } from './timeline-event-index';
  import { senderColor } from './timeline-format';

  interface Props {
    eventId: string;
    roomId?: string;
    events?: TimelineEventIndex;
    members?: readonly MemberView[];
    currentUserId?: string | null;
    reply?: boolean;
    icon?: Component;
    onJump?: (eventId: string) => void;
    body?: Snippet;
  }

  let {
    eventId,
    roomId = '',
    events,
    members = [],
    currentUserId = null,
    reply = false,
    icon: Icon = ArrowBendUpLeftIcon,
    onJump,
    body,
  }: Props = $props();
  const core = useCoreClient();
  const roomCosmetics = useRoomCosmetics();

  interface Preview {
    sender: string | null;
    body: string;
  }

  let fetched = $state<Preview | null>(null);
  let loaded = $derived(events?.get(eventId) ?? null);
  let preview = $derived(loaded ? previewOf(loaded, $i18n.t) : fetched);
  let name = $derived(
    preview?.sender
      ? (loaded?.sender_name ?? null) || memberName(members, preview.sender)
      : $i18n.t('timeline.unknownSender')
  );

  let cosmetics = $derived(roomCosmetics?.for(preview?.sender) ?? null);
  let tintOnLight = $derived(cosmetics?.colorOnLight ?? cosmetics?.colorOnDark ?? null);
  let tintOnDark = $derived(cosmetics?.colorOnDark ?? cosmetics?.colorOnLight ?? null);
  let replyStyle = $derived(reply ? preferences.replyPreviewStyle : null);
  let nameColor = $derived(
    currentUserId !== null && preview?.sender === currentUserId
      ? 'var(--primary-on-container)'
      : senderColor(preview?.sender ?? null)
  );

  function previewOf(item: TimelineItemView, t: Translate): Preview {
    const content = item.content;
    if (content.kind === 'redacted') return { sender: item.sender, body: t('timeline.redacted') };
    if (content.kind === 'hidden_event' && content.event_type === 'm.reaction') {
      const key = reactionKey(content.content);
      return {
        sender: item.sender,
        body: key ? t('timeline.replyToReaction', { key }) : t('timeline.redacted'),
      };
    }
    return { sender: item.sender, body: replyPreviewBody(content) || stateEventText(item, t) };
  }

  $effect(() => {
    if (loaded !== null || !roomId) return;
    const target = eventId;
    let current = true;
    fetched = null;
    const read = (room: string, id: string) => core.commands.eventSource(room, id);
    void readEventSource(read, roomId, target).then((event) => {
      if (!current || event === null) return;
      fetched = replyFallbackFromSource(JSON.stringify(event), $i18n.t);
    });
    return () => {
      current = false;
    };
  });
</script>

<button
  class={['target-preview', replyStyle && `target-${replyStyle}`, { tinted: tintOnLight }]}
  type="button"
  style:--target-name-color={nameColor}
  style:--target-on-light={tintOnLight}
  style:--target-on-dark={tintOnDark}
  disabled={!onJump}
  onclick={() => {
    onJump?.(eventId);
  }}
>
  {#if replyStyle !== 'connected'}<Icon class="target-icon" />{/if}
  <span class={['target-copy', { wrap: body !== undefined }]}>
    <span class="target-name" style:font-family={cosmetics?.font ?? undefined}>{name}</span>
    {#if body}{@render body()}{:else}<span>{preview?.body ?? ''}</span>{/if}
  </span>
</button>

<style>
  .target-preview {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--surface-on-container);
    cursor: pointer;
    display: grid;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    grid-template-columns: auto minmax(0, 1fr);
    line-height: 1.4;
    margin: 0;
    padding: var(--space-050) var(--space-200);
    text-align: start;
    width: 100%;
  }

  .target-preview:disabled {
    cursor: default;
  }

  .target-preview :global(.target-icon) {
    color: var(--primary-main);
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .target-copy {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .target-copy.wrap {
    white-space: normal;
  }

  .target-copy > :not(.target-name) {
    filter: brightness(var(--opacity-p300));
  }

  .target-preview:not(:disabled):is(:hover, :focus-visible) .target-copy > :not(.target-name) {
    filter: brightness(var(--opacity-p500));
  }

  .target-name {
    color: var(--target-name-color);
    font-weight: var(--font-weight-medium);
  }

  .tinted {
    --target-name-color: var(--target-on-light);
  }

  @media (prefers-color-scheme: dark) {
    :root:not(.light) .tinted {
      --target-name-color: var(--target-on-dark);
    }
  }

  :root.dark .tinted {
    --target-name-color: var(--target-on-dark);
  }

  @supports (color: oklch(from red l c h)) {
    .tinted {
      --target-name-color: oklch(
        from var(--target-on-light) clamp(0.25, l, 0.52) clamp(0, c, 0.19) h
      );
    }

    @media (prefers-color-scheme: dark) {
      :root:not(.light) .tinted {
        --target-name-color: oklch(
          from var(--target-on-dark) clamp(0.72, l, 0.92) clamp(0, c, 0.16) h
        );
      }
    }

    :root.dark .tinted {
      --target-name-color: oklch(
        from var(--target-on-dark) clamp(0.72, l, 0.92) clamp(0, c, 0.16) h
      );
    }
  }

  .target-compact {
    gap: var(--space-100);
    padding: 0;
  }

  .target-compact :global(.target-icon) {
    height: var(--size-x50);
    width: var(--size-x50);
  }

  .target-connected {
    --target-connector-width: var(--border-width-500);

    grid-template-columns: minmax(0, 1fr);
    min-height: var(--space-500);
    overflow: visible;
    padding-inline: 0;
    position: relative;
  }

  .target-connected::before {
    border-left: var(--target-connector-width) solid var(--surface-on-container);
    border-radius: var(--radius) 0 0;
    border-top: var(--target-connector-width) solid var(--surface-on-container);
    content: '';
    height: calc(50% + var(--space-100));
    left: calc(-1 * (var(--timeline-row-gap) + var(--avatar-size-small) / 2));
    opacity: var(--opacity-placeholder);
    pointer-events: none;
    position: absolute;
    top: calc(50% - var(--border-width-300));
    width: calc(var(--timeline-row-gap) / 2 + var(--avatar-size-small) / 2);
  }

  .target-connected:not(:disabled):is(:hover, :focus-visible)::before {
    opacity: var(--opacity-p300);
  }

  .target-expanded {
    --target-accent-width: var(--border-width-600);

    align-items: start;
    background: var(--surface-var-container);
    padding: var(--space-200) var(--space-300) var(--space-200)
      calc(var(--space-300) + var(--target-accent-width));
    position: relative;
  }

  .target-expanded::before {
    background: var(--primary-main);
    bottom: 0;
    content: '';
    left: 0;
    pointer-events: none;
    position: absolute;
    top: 0;
    width: var(--target-accent-width);
  }

  .target-expanded .target-copy {
    display: grid;
    gap: var(--space-050);
    white-space: normal;
  }

  .target-expanded .target-copy > :not(.target-name) {
    filter: none;
  }
</style>
