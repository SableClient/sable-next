<script lang="ts">
  import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOutIcon';
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
  import PushPinSlashIcon from 'phosphor-svelte/lib/PushPinSlashIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import type { MemberView, TimelineItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import {
    isNewPin,
    PIN_MARKER_EVENT_TYPE,
    pinsHash,
    unreadPinCount,
    type PinReadMarker,
  } from './pin-marker';
  import { useEventItems } from './event-items.svelte.js';
  import { pinErrorMessage } from './pinned-events.svelte.js';
  import MessagePreview from './MessagePreview.svelte';
  import { opensFrom } from './message-preview';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    canPin: boolean;
    revision?: number;
    onJump: (eventId: string) => void;
  }

  let { roomId, members, canPin, revision = 0, onJump }: Props = $props();
  const core = useCoreClient();
  const eventItems = useEventItems();

  let open = $state(false);
  let loading = $state(false);
  let pinnedIds = $state.raw<string[]>([]);
  let shownIds = $state.raw<string[]>([]);
  let entries = $state.raw<ReadonlyMap<string, TimelineItemView>>(new Map());
  let marker = $state.raw<PinReadMarker | null>(null);
  let currentHash = $state<string | null>(null);
  let run = 0;

  let ordered = $derived([...shownIds].reverse());
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

      const loaded = await core.commands.eventItems(target, ids);
      if (current !== run) return;
      entries = new Map(loaded.map((item) => [item.event_id ?? item.id, item]));
      shownIds = ids;
      eventItems.put(target, loaded);
      await markSeen(target, ids);
    } catch (error) {
      console.debug('[sable room] pins unavailable', error);
    } finally {
      if (current === run) loading = false;
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

  async function unpin(eventId: string): Promise<void> {
    try {
      pinnedIds = await core.commands.setPinned(roomId, eventId, false);
      shownIds = shownIds.filter((id) => id !== eventId);
    } catch (error) {
      console.warn('[sable room] unpin failed', error);
      toasts.error(pinErrorMessage(error));
    }
  }

  function jump(eventId: string): void {
    open = false;
    onJump(eventId);
  }
</script>

{#snippet pinTrigger({ props }: { props: Record<string, unknown> })}
  <PanelHeaderButton {...props} class="pin-button selection-open" label={$i18n.t('room.pinsTitle')}>
    <PushPinIcon weight={open ? 'fill' : 'regular'} />
    {#if unreadCount > 0}
      <span class="pin-badge" aria-hidden="true">{unreadCount}</span>
    {/if}
  </PanelHeaderButton>
{/snippet}

<ActionMenu
  bind:open
  label={$i18n.t('room.pinsTitle')}
  class="pin-menu"
  side="bottom"
  align="center"
  sideOffset={4}
  preventScroll={false}
  trigger={pinTrigger}
  onOpenChange={(next) => {
    if (next) void load();
    else void refreshCount();
  }}
>
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
        {#each ordered as eventId (eventId)}
          <li class="pin-item" class:fresh={isNewPin(pinnedIds, marker, eventId)}>
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div
              class="pin-open"
              onclick={(event) => {
                if (!opensFrom(event)) return;
                jump(eventId);
              }}
            >
              <MessagePreview
                {roomId}
                {eventId}
                item={entries.get(eventId) ?? null}
                {members}
                onJumpToEvent={jump}
              >
                {#snippet fallback()}
                  <p class="pin-unreadable">{$i18n.t('room.pinsUnreadable')}</p>
                {/snippet}
              </MessagePreview>
            </div>
            <div class="pin-actions">
              <IconButton
                variant="ghost"
                size="small"
                label={$i18n.t('room.pinsJump')}
                onclick={() => {
                  jump(eventId);
                }}
              >
                <ArrowSquareOutIcon />
              </IconButton>
              {#if canPin}
                <IconButton
                  variant="ghost"
                  size="small"
                  label={$i18n.t('timeline.unpinMessage')}
                  onclick={() => {
                    void unpin(eventId);
                  }}
                >
                  <PushPinSlashIcon />
                </IconButton>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </IconContext>
</ActionMenu>

<style>
  :global(.menu-surface.pin-menu) {
    --menu-min-width: 20rem;
    --menu-max-height: min(28rem, 70dvh);

    gap: var(--space-200);
    max-width: min(24rem, calc(100vw - var(--space-500)));
  }

  :global(.pin-button) {
    position: relative;
  }

  .pin-badge {
    background: var(--primary-main);
    border-radius: var(--radius-pill);
    color: var(--primary-on-main);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    left: 0;
    line-height: 1;
    min-width: 1rem;
    padding: var(--space-050) var(--space-100);
    position: absolute;
    text-align: center;
    top: 0;
  }

  .pin-header {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
    padding: var(--space-200) var(--space-200) var(--space-200) var(--space-300);
  }

  .pin-header h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .pin-status {
    display: flex;
    justify-content: center;
    margin: 0;
    padding: var(--space-500);
  }

  .pin-empty {
    display: grid;
    gap: var(--space-200);
    justify-items: center;
    padding: var(--space-500) var(--space-400);
    text-align: center;
  }

  .pin-empty :global(svg) {
    color: var(--surface-var-on-container);
    height: var(--icon-size-large);
    width: var(--icon-size-large);
  }

  .pin-empty-title {
    font-weight: var(--font-weight-500);
    margin: 0;
  }

  .pin-empty-hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .pin-list {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .pin-item {
    align-items: flex-start;
    border-radius: var(--radius-inner);
    display: flex;
    gap: var(--space-200);
    padding: 0 var(--space-200) 0 var(--space-400);
  }

  .pin-item.fresh {
    background: var(--primary-container);
    color: var(--primary-on-container);
  }

  .pin-open {
    cursor: pointer;
    flex: 1;
    min-width: 0;
  }

  .pin-actions {
    display: flex;
    flex: none;
    gap: var(--space-100);
    padding-block-start: var(--space-200);
  }

  .pin-unreadable {
    color: var(--surface-var-on-container);
    margin: 0;
    padding: var(--space-300) 0;
  }
</style>
