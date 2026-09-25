<script lang="ts">
  import { Collapsible } from 'bits-ui';
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
  import PushPinSlashIcon from 'phosphor-svelte/lib/PushPinSlashIcon';

  import type { MemberView, TimelineItemView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';

  import EditDiff from './EditDiff.svelte';
  import EventTargetPreview from './EventTargetPreview.svelte';
  import { isCustomReaction } from './reaction-emote-label';
  import StateContentDiff from './StateContentDiff.svelte';
  import StateEventText from './StateEventText.svelte';
  import { stateEventIcon } from './state-event-icon';
  import { reactionKey } from './state-event-text';
  import {
    isEditEvent,
    redactionTarget,
    relationOf,
    type TimelineEventIndex,
  } from './timeline-event-index';
  import { formatDate } from './timeline-format';
  import UndecryptableNotice from './UndecryptableNotice.svelte';

  const MAX_PIN_PREVIEWS = 4;

  interface Props {
    item: TimelineItemView;
    unreadCount: number;
    roomId?: string;
    events?: TimelineEventIndex;
    members?: readonly MemberView[];
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
    onJumpToEvent?: (eventId: string) => void;
  }

  let {
    item,
    unreadCount,
    roomId = '',
    events,
    members = [],
    onSenderProfile,
    onJumpToEvent,
  }: Props = $props();
  let peekOpen = $state(false);
  let StateIcon = $derived(stateEventIcon(item));
  let hiddenTarget = $derived.by((): string | null => {
    const content = item.content;
    if (content.kind !== 'hidden_event') return null;
    if (content.event_type === 'm.room.redaction') return redactionTarget(item);
    if (content.event_type === 'm.reaction' || isEditEvent(item)) {
      return relationOf(content.content)?.eventId ?? null;
    }
    return null;
  });
  let customReaction = $derived.by((): string | null => {
    const content = item.content;
    if (content.kind !== 'hidden_event' || content.event_type !== 'm.reaction') return null;
    const key = reactionKey(content.content);
    return key !== null && isCustomReaction(key) ? key : null;
  });
  let pins = $derived.by(() => {
    const content = item.content;
    if (content.kind !== 'state_event' || content.change?.kind !== 'pinned_events') return [];
    return [
      ...content.change.added.map((eventId) => ({ eventId, pinned: true })),
      ...content.change.removed.map((eventId) => ({ eventId, pinned: false })),
    ].slice(0, MAX_PIN_PREVIEWS);
  });
</script>

{#snippet stateGutter()}
  <span class="state-icon" aria-hidden="true"><StateIcon /></span>
{/snippet}

{#if item.content.kind === 'membership' || item.content.kind === 'profile_change' || (item.content.kind === 'state_event' && item.content.change !== null)}
  <p class="state">
    {@render stateGutter()}
    <StateEventText {item} {members} {onSenderProfile} />
  </p>
  {#if pins.length > 0}
    <div class="state-detail">
      {#each pins as pin (pin.eventId)}
        <EventTargetPreview
          eventId={pin.eventId}
          {roomId}
          {events}
          {members}
          icon={pin.pinned ? PushPinIcon : PushPinSlashIcon}
          onJump={onJumpToEvent}
        />
      {/each}
    </div>
  {/if}
{:else if item.content.kind === 'state_event'}
  <p class="state">
    {@render stateGutter()}
    <StateEventText {item} {members} {onSenderProfile} />
  </p>
  {#if item.content.content !== null}
    <div class="state-detail">
      <StateContentDiff before={item.content.prev_content} after={item.content.content} />
    </div>
  {/if}
{:else if hiddenTarget !== null}
  <p class="state">
    {@render stateGutter()}
    <span
      ><StateEventText {item} {members} {onSenderProfile} />{#if customReaction}
        <MediaImage
          class="state-emote"
          source={customReaction}
          alt={$i18n.t('timeline.customEmote')}
          width={64}
          height={64}
          original
        />{/if}</span
    >
  </p>
  <div class="state-detail">
    {#if isEditEvent(item)}
      <EventTargetPreview eventId={hiddenTarget} {roomId} {events} {members} onJump={onJumpToEvent}>
        {#snippet body()}<EditDiff {item} {roomId} {events} />{/snippet}
      </EventTargetPreview>
    {:else}
      <EventTargetPreview
        eventId={hiddenTarget}
        {roomId}
        {events}
        {members}
        onJump={onJumpToEvent}
      />
    {/if}
  </div>
{:else if item.content.kind === 'hidden_event'}
  {@const raw = item.content.content}
  <div class="debug-event">
    <code>{item.content.event_type}</code>
    <div class="debug-body">
      <span><StateEventText {item} {members} {onSenderProfile} /></span>
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
  <UndecryptableNotice id={item.id} cause={item.content.reason} />
{:else if item.content.kind === 'call_invite' || item.content.kind === 'malformed'}
  <p class="state">
    {@render stateGutter()}
    <StateEventText {item} {members} {onSenderProfile} />
  </p>
{:else if item.content.kind === 'unsupported'}
  <p class="state">
    {@render stateGutter()}
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
    {@render stateGutter()}
    <span class="redacted-label">
      {item.content.kind === 'redacted' && item.content.reason
        ? $i18n.t('timeline.redactedWithReason', { reason: item.content.reason })
        : $i18n.t('timeline.redacted')}
    </span>
  </p>
{/if}

<style>
  .separator,
  .unread,
  .date-divider,
  .state,
  .debug-event {
    margin: 0;
  }

  .separator {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    padding: var(--space-200);
    text-align: center;
  }

  .state {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-body);
    gap: var(--timeline-row-gap);
    line-height: var(--line-height-body);
    opacity: var(--opacity-p300);
    padding: 0;
  }

  .state-icon {
    align-items: center;
    display: flex;
    flex: 0 0 var(--avatar-size-small);
    justify-content: center;
  }

  .state-icon :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .state-detail {
    display: grid;
    gap: var(--space-050);
    margin-inline-start: calc(var(--avatar-size-small) + var(--timeline-row-gap));
    min-width: 0;
    padding-block: var(--space-050);
  }

  .state :global(.state-emote) {
    height: 1lh;
    margin-inline-start: var(--space-100);
    object-fit: contain;
    vertical-align: bottom;
    width: auto;
  }

  .redacted-label {
    align-items: center;
    border: var(--border-width) dashed var(--surface-var-container-line);
    border-radius: var(--radius-pill);
    display: inline-flex;
    gap: var(--space-100);
    padding: var(--space-050) var(--space-200);
  }

  .debug-event {
    align-items: baseline;
    background: var(--surface-var-container);
    border-block: var(--border-width) dashed var(--surface-var-container-line);
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    padding: var(--space-150) 0;
  }

  .debug-body {
    display: grid;
    gap: var(--space-050);
    min-width: 0;
  }

  .debug-body :global(.debug-peek-trigger) {
    background: none;
    border: 0;
    color: var(--primary-main);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    justify-self: start;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .debug-peek {
    background: var(--bg-container);
    border-radius: var(--radius);
    font-size: var(--font-size-small);
    margin: var(--space-100) 0 0;
    max-height: 14rem;
    overflow: auto;
    padding: var(--space-200);
  }

  .debug-event code {
    flex: 0 0 auto;
    font-family: var(--font-family-mono);
    margin-inline-start: calc(var(--avatar-size-small) + var(--space-250));
  }

  .date-divider {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-300);
    padding: var(--space-300) 0;
    text-align: center;
  }

  .date-divider::before,
  .date-divider::after {
    border-top: var(--border-width) solid var(--bg-container-line);
    content: '';
    flex: 1;
  }

  .date-divider span {
    font-weight: var(--font-weight-500);
    letter-spacing: 0.06em;
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
    border-top: var(--border-width) solid var(--success-main);
    content: '';
    flex: 1;
  }

  .read-marker span {
    color: var(--success-main);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .unread::before {
    border-top: calc(var(--border-width) * 2) solid var(--primary-main-line);
    content: '';
    flex: 1;
  }

  .unread span {
    background: var(--primary-container);
    border: var(--border-width) solid var(--primary-container-line);
    border-radius: var(--radius-pill);
    color: var(--primary-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.04em;
    padding: var(--space-050) var(--space-200);
  }
</style>
