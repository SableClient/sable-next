<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import ArrowBendUpLeftIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';

  import type { MemberView, ProfileView, TimelineItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  import { readEventSource } from './event-source-cache';
  import { memberName, senderDisplayColors } from '../members/members.js';
  import { replyFallbackFromSource } from './reply-fallback';
  import { replyPreviewBody } from './reply-preview';
  import { hasSenderRoles, useSenderRoles } from '../members/sender-roles';
  import SenderName from '../members/SenderName.svelte';
  import { reactionKey, stateEventText, type Translate } from '../timeline/state-event-text';
  import type { TimelineEventIndex } from '../timeline/timeline-event-index';

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
  const senderRoles = hasSenderRoles() ? useSenderRoles() : null;

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

  let persona = $derived(loaded?.per_message_profile ?? null);
  let cosmetics = $derived(persona ? null : (roomCosmetics?.for(preview?.sender) ?? null));
  let profile = $state<ProfileView | null>(null);
  let sender = $derived(preview?.sender ?? null);
  let colors = $derived(
    senderDisplayColors(
      sender ?? '',
      profile,
      persona,
      currentUserId !== null && sender === currentUserId,
      cosmetics,
      sender ? (senderRoles?.(sender)?.color ?? null) : null
    )
  );
  let replyStyle = $derived(reply ? preferences.replyPreviewStyle : null);

  $effect(() => {
    const userId = sender;
    profile = null;
    if (!userId) return;
    let current = true;
    void core.userProfile(userId).then(
      (next) => {
        if (current) profile = next;
      },
      () => undefined
    );
    return () => {
      current = false;
    };
  });

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
  class={['target-preview', replyStyle && `target-${replyStyle}`]}
  type="button"
  disabled={!onJump}
  onclick={() => {
    onJump?.(eventId);
  }}
>
  {#if replyStyle !== 'connected'}<Icon class="target-icon" />{/if}
  <span class={['target-copy', { wrap: body !== undefined }]}>
    <SenderName displayName={name} {colors} nameClass="target-name" compact />
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
    margin-bottom: var(--space-100);
    min-height: var(--space-500);
    overflow: visible;
    padding-block: 0;
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
    color: var(--surface-var-on-container);
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
