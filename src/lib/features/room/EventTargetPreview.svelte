<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import ArrowBendUpLeftIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';

  import type { MemberView, TimelineItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';

  import { readEventSource } from './event-source-cache';
  import { memberName } from './members.js';
  import { replyFallbackFromSource } from './reply-fallback';
  import { replyPreviewBody } from './reply-preview';
  import { reactionKey, stateEventText, type Translate } from './state-event-text';
  import type { TimelineEventIndex } from './timeline-event-index';

  interface Props {
    eventId: string;
    roomId?: string;
    events?: TimelineEventIndex;
    members?: readonly MemberView[];
    icon?: Component;
    onJump?: (eventId: string) => void;
    body?: Snippet;
  }

  let {
    eventId,
    roomId = '',
    events,
    members = [],
    icon: Icon = ArrowBendUpLeftIcon,
    onJump,
    body,
  }: Props = $props();
  const core = useCoreClient();

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
  class="target-preview"
  type="button"
  disabled={!onJump}
  onclick={() => {
    onJump?.(eventId);
  }}
>
  <Icon class="target-icon" />
  <span class={['target-copy', { wrap: body !== undefined }]}>
    <span class="target-name">{name}</span>
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
    filter: brightness(var(--opacity-p300));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .target-copy.wrap {
    white-space: normal;
  }

  .target-preview:not(:disabled):is(:hover, :focus-visible) .target-copy {
    filter: brightness(var(--opacity-p500));
  }

  .target-name {
    font-weight: var(--font-weight-medium);
  }
</style>
