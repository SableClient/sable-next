<script lang="ts">
  import type { TimelineItemView } from '#src/generated/TimelineItemView';
  import { i18n } from '#lib/i18n.js';
  import type { TimelineLayout } from '#lib/settings/preferences.svelte.js';
  import { onMount } from 'svelte';
  import { innerHeight } from 'svelte/reactivity/window';

  import TimelineItem from './TimelineItem.svelte';

  interface Props {
    mode?: 'initial' | 'history';
    layout?: TimelineLayout;
    targetHeight?: number;
    onHeightChange?: (height: number) => void;
  }

  let { mode = 'initial', layout = 'modern', targetHeight = 0, onHeightChange }: Props = $props();

  const APPROXIMATE_ROW_HEIGHT = 52;
  let seed = $state(0x6d2b79f5);

  onMount(() => {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    seed = values[0] ?? seed;
  });

  function random(index: number, salt: number): number {
    let value = (seed + Math.imul(index + 1, 0x9e3779b1) + Math.imul(salt, 0x85ebca6b)) >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15;
    value = Math.imul(value, 0x846ca68b);
    value ^= value >>> 16;
    return (value >>> 0) / 0x1_0000_0000;
  }

  function characterCount(index: number, collapsed: boolean): number {
    const value = random(index, 3);
    if (!collapsed && value < 0.12) return 0;
    if (value < 0.35) return 6 + Math.round((value / 0.35) * 18);
    if (value < 0.7) return 24 + Math.round(((value - 0.35) / 0.35) * 52);
    if (value < 0.9) return 76 + Math.round(((value - 0.7) / 0.2) * 94);
    return 170 + Math.round(((value - 0.9) / 0.1) * 180);
  }

  let availableHeight = $derived(
    mode === 'initial' ? Math.max(targetHeight, innerHeight.current ?? 0) : targetHeight
  );
  let rows = $derived(
    (() => {
      const count = Math.max(6, Math.ceil(availableHeight / APPROXIMATE_ROW_HEIGHT) + 1);
      let messagesLeftInGroup = 0;
      return Array.from({ length: count }, (_, index) => {
        const groupStart = messagesLeftInGroup === 0;
        if (groupStart) messagesLeftInGroup = 1 + Math.floor(random(index, 1) * 4);
        else messagesLeftInGroup -= 1;
        const collapsed = !groupStart;
        return {
          id: index,
          collapsed,
          groupStart: index > 0 && groupStart,
          characters: characterCount(index, collapsed),
        };
      });
    })()
  );

  function measureHeight(node: HTMLDivElement): () => void {
    if (!onHeightChange) return () => {};
    let frame = 0;
    const report = (): void => {
      const measured = Math.max(node.scrollHeight, node.getBoundingClientRect().height);
      if (measured > 0) onHeightChange?.(measured);
    };
    const observer = new ResizeObserver(report);
    observer.observe(node);
    frame = requestAnimationFrame(report);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }

  function placeholderItem(id: number): TimelineItemView {
    return {
      id: `placeholder-${String(id)}`,
      event_id: null,
      transaction_id: null,
      send_state: null,
      sender: null,
      sender_name: null,
      sender_avatar: null,
      timestamp: 0,
      content: {
        kind: 'message',
        body: '',
        html: '',
        emote: false,
        notice: false,
        edited: false,
      },
      in_reply_to: null,
      thread_root: null,
      thread_summary: null,
      reactions: [],
      is_own: false,
      read_by: [],
      per_message_profile: null,
      mention: 'none',
    };
  }
</script>

<div
  class={['timeline-placeholder', mode, 'items', `layout-${layout}`]}
  aria-label={$i18n.t('timeline.loading')}
  role="status"
  {@attach measureHeight}
>
  {#each rows as row (row.id)}
    <div
      class={[
        'placeholder-item',
        'item',
        { collapsed: row.collapsed, 'group-start': row.groupStart },
      ]}
    >
      <TimelineItem
        item={placeholderItem(row.id)}
        collapsed={row.collapsed}
        {layout}
        placeholder
        placeholderCharacters={row.characters}
      />
    </div>
  {/each}
</div>

<style>
  .timeline-placeholder {
    background: transparent;
    display: flex;
    flex-direction: column;
    pointer-events: none;
  }

  .timeline-placeholder.initial {
    inset: 0;
    justify-content: flex-end;
    overflow: hidden;
    position: absolute;
    z-index: 1;
  }

  .timeline-placeholder.history {
    inset: 0 0 auto;
    overflow: visible;
    position: absolute;
  }

  .placeholder-item {
    box-sizing: border-box;
    flex: 0 0 auto;
    padding: var(--timeline-row-padding) var(--page-gutter);
    width: 100%;
  }

  .placeholder-item.collapsed {
    padding-top: 0;
  }

  .placeholder-item.group-start {
    padding-top: calc(var(--timeline-row-padding) + var(--timeline-group-gap));
  }
</style>
