<script lang="ts">
  import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { isRecord } from '#lib/guards.js';
  import { i18n } from '#lib/i18n.js';

  import { editDiff } from './edit-diff';
  import { readEventSource } from './event-source-cache';
  import {
    editedBody,
    relationOf,
    type TimelineEventIndex,
  } from '../timeline/timeline-event-index';

  interface Props {
    item: ResolvedItem;
    roomId?: string;
    events?: TimelineEventIndex;
  }

  let { item, roomId = '', events }: Props = $props();
  const core = useCoreClient();

  let raw = $derived(item.content.kind === 'hidden_event' ? item.content.content : null);
  let after = $derived(editedBody(raw));
  let previous = $derived(events?.editBefore(item) ?? null);
  let original = $state<string | null>(null);
  let before = $derived(
    previous?.content.kind === 'hidden_event' ? editedBody(previous.content.content) : original
  );
  let display = $derived(
    before !== null && after !== null && before !== after ? editDiff(before, after) : null
  );

  $effect(() => {
    const target = relationOf(raw)?.eventId;
    if (previous !== null || !target || !roomId) return;
    let current = true;
    original = null;
    const read = (room: string, id: string) =>
      core.rpc.timeline
        .eventSource({ room_id: room, event_id: id, include_original: false })
        .then(({ source }) => source);
    void readEventSource(read, roomId, target).then((event) => {
      const content = event?.content;
      if (current && isRecord(content) && typeof content.body === 'string') original = content.body;
    });
    return () => {
      current = false;
    };
  });
</script>

{#if display?.mode === 'inline'}
  <span class="edit-diff"
    >{#each display.parts as part, index (index)}{#if part.added}<ins>{part.value}</ins
        >{:else if part.removed}<del>{part.value}</del>{:else}<span>{part.value}</span
        >{/if}{/each}</span
  >
{:else if display?.mode === 'lines'}
  <span class="edit-diff lines">
    {#each display.rows as row, index (index)}
      {#if row.kind === 'skip'}
        <span class="skip">{i18n.t('timeline.editUnchangedLines', { count: row.count })}</span>
      {:else if row.kind === 'added'}
        <ins>{row.text}</ins>
      {:else if row.kind === 'removed'}
        <del>{row.text}</del>
      {:else}
        <span>{row.text}</span>
      {/if}
    {/each}
  </span>
{:else if after !== null}
  <span>{after}</span>
{/if}

<style>
  .edit-diff {
    white-space: pre-wrap;
  }

  .lines {
    display: grid;
  }

  .lines > :empty::before {
    content: '\200b';
  }

  .skip {
    font-size: var(--font-size-small);
    font-style: italic;
  }

  ins {
    background: var(--success-container);
    color: var(--success-on-container);
    text-decoration: none;
  }

  del {
    background: var(--crit-container);
    color: var(--crit-on-container);
  }
</style>
