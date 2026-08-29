<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import '#lib/ui/primitives/menu.css';

  interface Props {
    open?: boolean;
    fromRoomId: string;
    onForward: (toRoomIds: string[]) => void;
  }

  let { open = $bindable(false), fromRoomId, onForward }: Props = $props();
  const roomList = useRoomList();
  let search = $state('');
  let selected = $state<string[]>([]);
  const fieldId = $props.id();

  let targets = $derived(
    roomList.rooms
      .filter((room) => room.state === 'joined' && !room.is_space && room.room_id !== fromRoomId)
      .filter((room) =>
        (room.name ?? room.room_id).toLowerCase().includes(search.trim().toLowerCase())
      )
  );

  function toggle(roomId: string): void {
    selected = selected.includes(roomId)
      ? selected.filter((id) => id !== roomId)
      : [...selected, roomId];
  }

  function send(): void {
    if (selected.length === 0) return;
    const rooms = selected;
    open = false;
    search = '';
    selected = [];
    onForward(rooms);
  }

  function cancel(): void {
    open = false;
    search = '';
    selected = [];
  }
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('timeline.forwardTitle')}>
  <div class="forward">
    <h2>{$i18n.t('timeline.forwardTitle')}</h2>
    <TextInput
      id={fieldId}
      bind:value={search}
      placeholder={$i18n.t('timeline.forwardSearch')}
      aria-label={$i18n.t('timeline.forwardSearch')}
    />
    {#if targets.length === 0}
      <p class="empty">{$i18n.t('timeline.forwardEmpty')}</p>
    {:else}
      <ul class="targets">
        {#each targets as room (room.room_id)}
          {@const checked = selected.includes(room.room_id)}
          <li>
            <button
              type="button"
              class="sable-menu-item"
              role="checkbox"
              aria-checked={checked}
              onclick={() => {
                toggle(room.room_id);
              }}
            >
              <Avatar size="small" src={room.avatar_url} name={room.name} />
              <span class="name">{room.name ?? room.room_id}</span>
              <span class="tick" aria-hidden="true">
                {#if checked}<CheckIcon size={14} weight="bold" />{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="actions">
      <span class="count" aria-live="polite">
        {selected.length === 0
          ? ''
          : $i18n.t('timeline.forwardSelected', { count: selected.length })}
      </span>
      <Button variant="ghost" onclick={cancel}>{$i18n.t('timeline.forwardCancel')}</Button>
      <Button disabled={selected.length === 0} onclick={send}>
        {$i18n.t('timeline.forwardSend')}
      </Button>
    </div>
  </div>
</DialogFrame>

<style>
  .forward {
    display: grid;
    gap: var(--space-300);
    width: min(24rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-h4);
    line-height: var(--line-height-h4);
    margin: 0;
  }

  .targets {
    display: grid;
    list-style: none;
    margin: 0;
    max-height: 20rem;
    overflow: auto;
    padding: 0;
  }

  .targets :global(.sable-menu-item) {
    --menu-item-height: var(--control-height-500);
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tick {
    align-items: center;
    color: var(--sable-primary-main);
    display: inline-flex;
    flex: none;
    height: 1.125rem;
    justify-content: center;
    width: 1.125rem;
  }

  .empty {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-t300);
    margin: 0;
  }

  .actions {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }

  .count {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin-right: auto;
  }
</style>
