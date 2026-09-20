<script lang="ts">
  import type { RoomSummary } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import RoomIcon from '#lib/ui/primitives/RoomIcon.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import UnreadBadge from '#lib/ui/primitives/UnreadBadge.svelte';
  import '#lib/ui/primitives/menu.css';

  import { fuzzyMatchIndices } from './fuzzy.js';
  import {
    filterRoomsByQuery,
    parentSpaceNames,
    parseJumpQuery,
    roomDisplayName,
  } from './room-jump.js';

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
  let parsed = $derived(parseJumpQuery(query));
  let results = $derived(filterRoomsByQuery(roomList.rooms, query));
  let parents = $derived(parentSpaceNames(roomList.rooms));
  let active = $derived(Math.min(activeIndex, Math.max(0, results.length - 1)));
  let heading = $derived(parsed.text === '' ? $i18n.t('shortcuts.paletteRecents') : null);

  function optionId(index: number): string {
    return `${uid}-option-${index}`;
  }

  function nameParts(name: string): { text: string; match: boolean }[] {
    const indices = new Set(fuzzyMatchIndices(name, parsed.text));
    if (indices.size === 0) return [{ text: name, match: false }];

    const parts: { text: string; match: boolean }[] = [];
    for (const [index, character] of [...name].entries()) {
      const match = indices.has(index);
      const last = parts.at(-1);
      if (last && last.match === match) last.text += character;
      else parts.push({ text: character, match });
    }

    return parts;
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
  <p class="hint">{$i18n.t('shortcuts.paletteHint')}</p>
  {#if results.length === 0}
    <p class="empty">{$i18n.t('shortcuts.paletteEmpty')}</p>
  {:else}
    {#if heading}<p class="heading">{heading}</p>{/if}
    <ul
      id={listboxId}
      role="listbox"
      aria-label={$i18n.t('shortcuts.paletteLabel')}
      {@attach keepActiveInView}
    >
      {#each results as room, index (room.room_id)}
        {@const name = roomDisplayName(room)}
        {@const parent = parents.get(room.room_id)}
        <li role="presentation">
          <button
            type="button"
            class="menu-item option selection-highlight"
            id={optionId(index)}
            role="option"
            tabindex="-1"
            data-index={index}
            aria-selected={index === active}
            onclick={() => onSelect(room)}
          >
            <Avatar
              class={['jump-avatar', { glyph: !room.avatar_url }]}
              size="small"
              id={room.avatar_url ? room.room_id : null}
              src={room.avatar_url}
              {name}
              uniform
            >
              <RoomIcon isSpace={room.is_space} isVoice={room.is_voice} joinRule={room.join_rule} />
            </Avatar>
            <span class="text">
              <span class="name"
                >{#each nameParts(name) as part, partIndex (partIndex)}{#if part.match}<mark
                      >{part.text}</mark
                    >{:else}{part.text}{/if}{/each}</span
              >
              {#if parent}<span class="parent">{parent}</span>{/if}
            </span>
            <UnreadBadge counts={roomList.unreadFor(room)} dm={room.is_direct} aria-hidden="true" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .jump-list {
    display: grid;
    gap: var(--space-200);
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

  .jump-list :global(.jump-avatar.glyph) {
    opacity: var(--opacity-p500);
  }

  .jump-list :global(.jump-avatar.glyph .avatar-fallback) {
    background: none;
  }

  .text {
    display: grid;
    flex: 1;
    min-width: 0;
    text-align: left;
  }

  .name,
  .parent {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .parent {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  mark {
    background: none;
    color: var(--primary-main);
    font-weight: var(--font-weight-bold);
  }

  .heading,
  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .empty {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: var(--space-400) 0 0;
    text-align: center;
  }
</style>
