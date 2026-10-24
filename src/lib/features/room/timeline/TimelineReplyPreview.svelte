<script lang="ts">
  import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpRightIcon';

  import type {
    MemberView,
    PerMessageProfileView,
    ProfileView,
    ReplyView,
  } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { profileOverrides } from '#lib/profile/profile-overrides.svelte.js';
  import { useRoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { findMember, senderDisplayColors, stripReplyFallback } from '../members/members.js';
  import SenderName from '../members/SenderName.svelte';
  import { hasSenderRoles, useSenderRoles } from '../members/sender-roles.js';
  import { replyText } from '../messages/reply-fallback.js';
  import { stateEventText } from './state-event-text';

  interface Props {
    reply: ReplyView;
    target: ResolvedItem | null;
    sender: string | null;
    persona: PerMessageProfileView | null;
    profile: ProfileView | null;
    currentUserId: string | null;
    members: readonly MemberView[];
    onJumpToEvent?: (eventId: string) => void;
  }

  let { reply, target, sender, persona, profile, currentUserId, members, onJumpToEvent }: Props =
    $props();

  const roomCosmetics = useRoomCosmetics();
  const senderRoles = hasSenderRoles() ? useSenderRoles() : null;

  let roomName = $derived.by(() => {
    const member = findMember(members, sender);
    return member ? member.display_name : (reply.sender_name ?? target?.sender_name ?? null);
  });
  let nameBase = $derived(
    persona?.display_name ??
      profileOverrides.name(sender ?? '', roomName ?? sender ?? i18n.t('timeline.unknownSender'))
  );
  let name = $derived(
    reply.sender_mentioned && !nameBase.startsWith('@') ? `@${nameBase}` : nameBase
  );
  let body = $derived.by(() => {
    const kind = target?.content.kind;
    if (
      target &&
      (kind === 'membership' ||
        kind === 'profile_change' ||
        kind === 'state_event' ||
        kind === 'hidden_event')
    ) {
      return stateEventText(target, i18n.t);
    }
    return stripReplyFallback(replyText(reply, i18n.t), persona);
  });
  let cosmetics = $derived(persona ? null : (roomCosmetics?.for(reply.sender) ?? null));
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
</script>

{#snippet copy()}
  <span class="reply-copy"
    ><SenderName displayName={name} {colors} nameClass="reply-name" compact />
    <span class="reply-body">{body}</span></span
  >
{/snippet}

{#if preferences.replyPreviewStyle === 'connected'}
  <button
    class={['reply-preview', 'reply-connected']}
    type="button"
    onclick={() => {
      onJumpToEvent?.(reply.event_id);
    }}
  >
    {@render copy()}
  </button>
{:else}
  <button
    class={['reply-preview', `reply-${preferences.replyPreviewStyle}`]}
    type="button"
    onclick={() => {
      onJumpToEvent?.(reply.event_id);
    }}
  >
    <ReplyIcon class="reply-icon" />
    {@render copy()}
  </button>
{/if}

<style>
  .reply-preview {
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
    margin-bottom: var(--space-100);
    padding: var(--space-100) var(--space-200);
    text-align: start;
    width: 100%;
  }

  .reply-preview :global(.reply-icon) {
    color: var(--primary-main);
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .reply-copy {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* WebKit uses a clipped inline-block's bottom as its baseline. */
  :global(.reply-name) {
    display: inline-block;
    overflow: clip;
    vertical-align: top;
  }

  .reply-compact {
    gap: var(--space-100);
    padding: 0;
  }

  .reply-compact :global(.reply-icon) {
    height: var(--size-x50);
    width: var(--size-x50);
  }

  .reply-compact .reply-body,
  .reply-connected .reply-body {
    filter: brightness(var(--opacity-p300));
  }

  .reply-connected {
    --reply-connector-width: var(--border-width-500);

    grid-column: 1 / -1;
    grid-template-columns: minmax(0, 1fr);
    margin-bottom: var(--space-100);
    min-height: var(--space-500);
    overflow: visible;
    padding-block: 0;
    padding-inline: 0;
    position: relative;
  }

  .reply-connected::before {
    border-left: var(--reply-connector-width) solid var(--surface-on-container);
    border-radius: var(--radius) 0 0;
    border-top: var(--reply-connector-width) solid var(--surface-on-container);
    content: '';
    height: calc(var(--space-250) + var(--border-width-300));
    left: calc(-1 * (var(--timeline-row-gap) + var(--avatar-size-small) / 2));
    opacity: var(--opacity-placeholder);
    pointer-events: none;
    position: absolute;
    top: calc(50% - var(--border-width-300));
    width: calc(var(--timeline-row-gap) / 2 + var(--avatar-size-small) / 2);
  }

  .reply-connected:is(:hover, :focus-visible)::before {
    opacity: var(--opacity-p300);
  }

  .reply-expanded {
    --reply-accent-width: var(--border-width-600);

    align-items: start;
    background: var(--surface-var-container);
    color: var(--surface-var-on-container);
    grid-template-columns: auto minmax(0, 1fr);
    padding: var(--space-200) var(--space-300) var(--space-200)
      calc(var(--space-300) + var(--reply-accent-width));
    position: relative;
  }

  .reply-expanded::before {
    background: var(--primary-main);
    bottom: 0;
    content: '';
    left: 0;
    pointer-events: none;
    position: absolute;
    top: 0;
    width: var(--reply-accent-width);
  }

  .reply-expanded .reply-copy {
    display: grid;
    gap: var(--space-050);
    white-space: normal;
  }

  .reply-expanded .reply-copy > span {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    overflow: hidden;
  }

  .reply-preview:is(:hover, :focus-visible) .reply-body {
    filter: brightness(var(--opacity-p500));
  }

  .reply-expanded:is(:hover, :focus-visible) {
    background: var(--surface-var-container-hover);
  }

  .reply-preview:focus-visible .reply-copy {
    text-decoration: underline;
    text-decoration-thickness: var(--border-width);
    text-underline-offset: 0.15em;
  }

  :global(.message.layout-compact) .reply-connected::before {
    left: calc(var(--space-050) - var(--space-300));
    width: calc(var(--space-300) - var(--space-150));
  }

  :global(.message.layout-bubble.own.align-own) .reply-preview {
    grid-template-columns: minmax(0, 1fr) auto;
    text-align: end;
    width: auto;
  }

  :global(.message.layout-bubble.own.align-own) .reply-preview :global(.reply-icon) {
    grid-column: 2;
    grid-row: 1;
  }

  :global(.message.layout-bubble.own.align-own) .reply-connected {
    text-align: end;
  }

  :global(.message.layout-bubble.own.align-own) .reply-connected::before {
    border-left: 0;
    border-radius: 0 var(--radius) 0 0;
    border-right: var(--reply-connector-width) solid var(--surface-on-container);
    left: auto;
    right: calc(-1 * (var(--timeline-row-gap) + var(--avatar-size-small) / 2));
  }
</style>
