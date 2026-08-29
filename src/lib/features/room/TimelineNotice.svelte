<script lang="ts">
  import { Collapsible } from 'bits-ui';

  import type { TimelineItemView } from '#src/generated/TimelineItemView';

  import { resolve } from '$app/paths';

  import { i18n } from '#lib/i18n.js';
  import { SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.js';

  import StateEventText from './StateEventText.svelte';
  import { formatDate } from './timeline-format';
  import { utdCauseKey, utdIsRecoverable } from './utd-cause';

  interface Props {
    item: TimelineItemView;
    unreadCount: number;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let { item, unreadCount, onSenderProfile }: Props = $props();
  let peekOpen = $state(false);
</script>

{#if item.content.kind === 'membership' || item.content.kind === 'profile_change' || (item.content.kind === 'state_event' && item.content.change !== null)}
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
  {@const cause = item.content.reason}
  <p class="undecryptable">
    {$i18n.t(utdCauseKey(cause))}
    {#if utdIsRecoverable(cause)}
      <a
        href={resolve('/(app)/settings/[section]', { section: SETTINGS_DEVICES_SECTION })}
        data-settings-link={SETTINGS_DEVICES_SECTION}
      >
        {$i18n.t('timeline.utdRecoverAction')}
      </a>
    {/if}
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
  .debug-event,
  .undecryptable {
    margin: 0;
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
</style>
