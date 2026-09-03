<script lang="ts">
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import '#lib/ui/primitives/menu.css';

  import { filterRoomsByQuery, roomDisplayName } from './room-jump.js';

  interface Props {
    onSelect: (room: RoomSummary) => void;
    onClose?: () => void;
  }

  let { onSelect, onClose }: Props = $props();

  const roomList = useRoomList();
  const uid = $props.id();
  const inputId = `${uid}-input`;
  const listboxId = `${uid}-listbox`;

  let query = $state('');
  let activeIndex = $state(0);
  let results = $derived(filterRoomsByQuery(roomList.rooms, query));
  let active = $derived(Math.min(activeIndex, Math.max(0, results.length - 1)));

  function optionId(index: number): string {
    return `${uid}-option-${index}`;
  }

  function keepActiveInView(node: HTMLElement): void {
    node.querySelector(`[data-index="${String(active)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (results.length > 0) activeIndex = (active + 1) % results.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length > 0) activeIndex = (active - 1 + results.length) % results.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const room = results[active];
      if (room) onSelect(room);
    } else if (event.key === 'Escape') {
      onClose?.();
    }
  }
</script>

<div class="jump-list">
  <TextInput
    id={inputId}
    bind:value={query}
    onkeydown={onKeydown}
    role="combobox"
    aria-expanded="true"
    aria-controls={listboxId}
    aria-activedescendant={results.length > 0 ? optionId(active) : undefined}
    aria-autocomplete="list"
    aria-label={$i18n.t('shortcuts.paletteLabel')}
    placeholder={$i18n.t('shortcuts.palettePlaceholder')}
    autocomplete="off"
  />
  {#if results.length === 0}
    <p class="empty">{$i18n.t('shortcuts.paletteEmpty')}</p>
  {:else}
    <ul
      id={listboxId}
      role="listbox"
      aria-label={$i18n.t('shortcuts.paletteLabel')}
      {@attach keepActiveInView}
    >
      {#each results as room, index (room.room_id)}
        <li role="presentation">
          <button
            type="button"
            class="sable-menu-item option sable-highlight"
            id={optionId(index)}
            role="option"
            tabindex="-1"
            data-index={index}
            aria-selected={index === active}
            onclick={() => onSelect(room)}
          >
            <Avatar size="small" src={room.avatar_url} name={roomDisplayName(room)} />
            <span class="name">{roomDisplayName(room)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .jump-list {
    display: grid;
    gap: var(--space-300);
    padding: var(--space-400);
  }

  ul {
    display: grid;
    gap: var(--space-100);
    list-style: none;
    margin: 0;
    max-height: min(60vh, 24rem);
    overflow-y: auto;
    padding: 0;
  }

  .option {
    --menu-item-height: var(--control-height-500);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: var(--space-400) 0 0;
    text-align: center;
  }
</style>
