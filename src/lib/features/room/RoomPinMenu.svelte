<script lang="ts">
  import { Popover } from 'bits-ui';
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
  import PushPinSlashIcon from 'phosphor-svelte/lib/PushPinSlashIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import type { MemberView } from '#src/generated/MemberView';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import {
    isNewPin,
    PIN_MARKER_EVENT_TYPE,
    pinsHash,
    unreadPinCount,
    type PinReadMarker,
  } from './pin-marker';
  import { formatTime } from './timeline-format';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import { memberAvatar, memberName } from './members.js';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    canPin: boolean;
    revision?: number;
    onJump: (eventId: string) => void;
  }

  let { roomId, members, canPin, revision = 0, onJump }: Props = $props();
  const core = useCoreClient();

  interface PinnedEntry {
    eventId: string;
    sender: string | null;
    body: string | null;
    timestamp: number | null;
  }

  let open = $state(false);
  let loading = $state(false);
  let pinnedIds = $state.raw<string[]>([]);
  let entries = $state.raw<PinnedEntry[]>([]);
  let marker = $state.raw<PinReadMarker | null>(null);
  let currentHash = $state<string | null>(null);
  let run = 0;

  let ordered = $derived([...entries].reverse());
  let unreadCount = $derived(unreadPinCount(pinnedIds, marker, currentHash));

  $effect(() => {
    void roomId;
    void revision;
    void refreshCount();
  });

  async function refreshCount(): Promise<void> {
    const target = roomId;
    if (!target) return;

    const current = ++run;
    try {
      const [ids, stored] = await Promise.all([
        core.commands.pinnedEvents(target),
        core.commands.roomAccountData(target, PIN_MARKER_EVENT_TYPE),
      ]);
      if (current !== run) return;

      pinnedIds = ids;
      marker = readMarker(stored);
      currentHash = await pinsHash(ids);
    } catch (error) {
      console.debug('[sable room] pins unavailable', error);
    }
  }

  function readMarker(stored: unknown): PinReadMarker | null {
    if (typeof stored !== 'object' || stored === null) return null;
    const candidate = stored as Partial<PinReadMarker>;
    if (typeof candidate.hash !== 'string' || typeof candidate.last_seen_id !== 'string') {
      return null;
    }
    return {
      hash: candidate.hash,
      count: typeof candidate.count === 'number' ? candidate.count : 0,
      last_seen_id: candidate.last_seen_id,
    };
  }

  async function load(): Promise<void> {
    const target = roomId;
    if (!target) return;

    const current = ++run;
    loading = true;
    try {
      const ids = await core.commands.pinnedEvents(target);
      if (current !== run) return;
      pinnedIds = ids;

      const loaded = await Promise.all(ids.map((eventId) => readEvent(target, eventId)));
      if (current !== run) return;
      entries = loaded;
      await markSeen(target, ids);
    } catch (error) {
      console.debug('[sable room] pins unavailable', error);
    } finally {
      if (current === run) loading = false;
    }
  }

  async function readEvent(target: string, eventId: string): Promise<PinnedEntry> {
    try {
      const source: unknown = JSON.parse(await core.commands.eventSource(target, eventId));
      if (typeof source !== 'object' || source === null) {
        return { eventId, sender: null, body: null, timestamp: null };
      }

      const event = source as {
        sender?: unknown;
        origin_server_ts?: unknown;
        content?: { body?: unknown };
      };
      return {
        eventId,
        sender: typeof event.sender === 'string' ? event.sender : null,
        body: typeof event.content?.body === 'string' ? event.content.body : null,
        timestamp: typeof event.origin_server_ts === 'number' ? event.origin_server_ts : null,
      };
    } catch (error) {
      console.debug('[sable room] pinned event unreadable', error);
      return { eventId, sender: null, body: null, timestamp: null };
    }
  }

  async function markSeen(target: string, ids: readonly string[]): Promise<void> {
    const lastSeen = ids.at(-1);
    if (lastSeen === undefined) return;

    const next: PinReadMarker = {
      hash: await pinsHash(ids),
      count: ids.length,
      last_seen_id: lastSeen,
    };
    marker = next;
    currentHash = next.hash;
    try {
      await core.commands.setRoomAccountData(target, PIN_MARKER_EVENT_TYPE, next);
    } catch (error) {
      console.debug('[sable room] pin marker not stored', error);
    }
  }

  function senderName(userId: string | null): string {
    return userId === null ? $i18n.t('timeline.unknownSender') : memberName(members, userId);
  }

  function senderAvatar(userId: string | null): string | null {
    return userId === null ? null : memberAvatar(members, userId);
  }

  async function unpin(eventId: string): Promise<void> {
    try {
      pinnedIds = await core.commands.setPinned(roomId, eventId, false);
      entries = entries.filter((entry) => entry.eventId !== eventId);
    } catch (error) {
      console.warn('[sable room] unpin failed', error);
    }
  }

  function jump(eventId: string): void {
    open = false;
    onJump(eventId);
  }
</script>

<Popover.Root
  bind:open
  onOpenChange={(next) => {
    if (next) void load();
    else void refreshCount();
  }}
>
  <Popover.Trigger>
    {#snippet child({ props })}
      <IconButton
        {...props}
        class="pin-button"
        variant="ghost"
        size="small"
        label={$i18n.t('room.pinsTitle')}
      >
        <PushPinIcon weight={open ? 'fill' : 'regular'} />
        {#if unreadCount > 0}
          <span class="pin-badge" aria-hidden="true">{unreadCount}</span>
        {/if}
      </IconButton>
    {/snippet}
  </Popover.Trigger>

  <Popover.Content class="sable-menu pin-menu" side="bottom" align="center" sideOffset={4}>
    <IconContext values={{ 'aria-hidden': 'true' }}>
      <header class="pin-header">
        <h2>{$i18n.t('room.pinsTitle')}</h2>
        <IconButton
          variant="ghost"
          size="small"
          label={$i18n.t('room.pinsClose')}
          onclick={() => {
            open = false;
          }}
        >
          <XIcon />
        </IconButton>
      </header>

      {#if loading && ordered.length === 0}
        <p class="pin-status" role="status"><Spinner small /></p>
      {:else if ordered.length === 0}
        <div class="pin-empty">
          <PushPinIcon />
          <p class="pin-empty-title">{$i18n.t('room.pinsEmpty')}</p>
          <p class="pin-empty-hint">{$i18n.t('room.pinsEmptyHint')}</p>
        </div>
      {:else}
        <ul class="pin-list">
          {#each ordered as entry (entry.eventId)}
            <li class="pin-item" class:fresh={isNewPin(pinnedIds, marker, entry.eventId)}>
              <button
                class="pin-open sable-selection-layer"
                type="button"
                onclick={() => {
                  jump(entry.eventId);
                }}
              >
                <Avatar
                  src={senderAvatar(entry.sender)}
                  name={senderName(entry.sender)}
                  size="small"
                />
                <span class="pin-text">
                  <span class="pin-meta">
                    <span class="pin-sender">{senderName(entry.sender)}</span>
                    {#if entry.timestamp !== null}
                      <span class="pin-time">{formatTime(entry.timestamp)}</span>
                    {/if}
                  </span>
                  <span class="pin-body">{entry.body ?? $i18n.t('room.pinsUnreadable')}</span>
                </span>
              </button>
              {#if canPin}
                <IconButton
                  variant="ghost"
                  size="small"
                  label={$i18n.t('timeline.unpinMessage')}
                  onclick={() => {
                    void unpin(entry.eventId);
                  }}
                >
                  <PushPinSlashIcon />
                </IconButton>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </IconContext>
  </Popover.Content>
</Popover.Root>

<style>
  :global(.pin-menu) {
    --menu-min-width: 20rem;
    --menu-max-height: min(28rem, 70dvh);

    gap: var(--space-1);
    max-width: min(24rem, calc(100vw - var(--space-4)));
  }

  :global(.pin-button) {
    position: relative;
  }

  .pin-badge {
    background: var(--sable-primary-main);
    border-radius: var(--radius-pill);
    color: var(--sable-primary-on-main);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    left: 0;
    line-height: 1;
    min-width: 1rem;
    padding: 0.0625rem 0.1875rem;
    position: absolute;
    text-align: center;
    top: 0;
  }

  .pin-header {
    align-items: center;
    display: flex;
    gap: var(--space-2);
    justify-content: space-between;
    padding: var(--space-1) var(--space-1) var(--space-1) var(--space-2);
  }

  .pin-header h2 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .pin-status {
    display: flex;
    justify-content: center;
    margin: 0;
    padding: var(--space-4);
  }

  .pin-empty {
    display: grid;
    gap: var(--space-1);
    justify-items: center;
    padding: var(--space-4) var(--space-3);
    text-align: center;
  }

  .pin-empty :global(svg) {
    color: var(--sable-surface-var-on-container);
    height: var(--icon-size-large);
    width: var(--icon-size-large);
  }

  .pin-empty-title {
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .pin-empty-hint {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .pin-list {
    display: grid;
    gap: var(--space-1);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .pin-item {
    align-items: center;
    border-radius: var(--radii-400);
    display: flex;
    gap: var(--space-1);
    padding-right: var(--space-1);
  }

  .pin-item.fresh {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  .pin-open {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radii-400);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    font: inherit;
    gap: var(--space-2);
    min-width: 0;
    padding: var(--space-1) var(--space-2);
    text-align: left;
  }

  .pin-text {
    display: grid;
    gap: var(--space-hairline);
    min-width: 0;
  }

  .pin-meta {
    align-items: baseline;
    display: flex;
    gap: var(--space-1);
    min-width: 0;
  }

  .pin-sender {
    font-weight: var(--font-weight-bold);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pin-time {
    color: var(--sable-surface-var-on-container);
    flex: 0 0 auto;
    font-size: var(--font-size-small);
  }

  .pin-body {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
