<script lang="ts">
  import { Collapsible } from 'bits-ui';

  import type { TimelineItemView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';

  import StateEventText from './StateEventText.svelte';
  import { stateEventIcon } from './state-event-icon';
  import { formatDate } from './timeline-format';
  import UndecryptableNotice from './UndecryptableNotice.svelte';

  interface Props {
    item: TimelineItemView;
    unreadCount: number;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let { item, unreadCount, onSenderProfile }: Props = $props();
  let peekOpen = $state(false);
  let StateIcon = $derived(stateEventIcon(item));
</script>

{#snippet stateGutter()}
  <span class="state-icon" aria-hidden="true"><StateIcon /></span>
{/snippet}

{#if item.content.kind === 'membership' || item.content.kind === 'profile_change' || (item.content.kind === 'state_event' && item.content.change !== null)}
  <p class="state">
    {@render stateGutter()}
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
  <UndecryptableNotice id={item.id} cause={item.content.reason} />
{:else if item.content.kind === 'call_invite' || item.content.kind === 'malformed'}
  <p class="state">
    {@render stateGutter()}
    <StateEventText {item} {onSenderProfile} />
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
