<script lang="ts">
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import '#lib/ui/primitives/menu.css';

  interface Props {
    open: boolean;
    room: RoomSummary;
    spaces: readonly RoomSummary[];
    onOpenChange: (open: boolean) => void;
    onApply: (spaceIds: string[]) => void;
  }

  let { open, room, spaces, onOpenChange, onApply }: Props = $props();
  let search = $state('');
  const selected = new SvelteSet<string>();
  const fieldId = $props.id();

  let targets = $derived(
    spaces.filter((space) =>
      (space.name ?? space.room_id).toLowerCase().includes(search.trim().toLowerCase())
    )
  );

  function toggle(spaceId: string): void {
    if (selected.has(spaceId)) selected.delete(spaceId);
    else selected.add(spaceId);
  }

  function close(): void {
    selected.clear();
    search = '';
    onOpenChange(false);
  }

  function apply(): void {
    if (selected.size === 0) return;
    onApply([...selected]);
    close();
  }
</script>

<DialogFrame
  {open}
  onOpenChange={(next) => {
    if (!next) close();
  }}
  variant="verification"
  label={$i18n.t('room.addToSpaceTitle', { name: room.name ?? room.room_id })}
>
  <h2>{$i18n.t('room.addToSpaceTitle', { name: room.name ?? room.room_id })}</h2>
  <TextInput
    id={fieldId}
    bind:value={search}
    placeholder={$i18n.t('room.addToSpaceSearch')}
    aria-label={$i18n.t('room.addToSpaceSearch')}
  />
  {#if targets.length === 0}
    <p class="empty">{$i18n.t('room.addToSpaceEmpty')}</p>
  {:else}
    <ul class="targets">
      {#each targets as space (space.room_id)}
        <li>
          <label class="sable-menu-item target">
            <input
              type="checkbox"
              checked={selected.has(space.room_id)}
              onchange={() => {
                toggle(space.room_id);
              }}
            />
            <Avatar size="small" src={space.avatar_url} name={space.name} />
            <span class="name">{space.name ?? space.room_id}</span>
          </label>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="actions">
    <Button variant="ghost" onclick={close}>{$i18n.t('room.leaveCancel')}</Button>
    <Button variant="primary" disabled={selected.size === 0} onclick={apply}>
      {$i18n.t('room.addToSpaceApply', { count: selected.size })}
    </Button>
  </div>
</DialogFrame>

<style>
  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0 0 var(--space-300);
  }

  .targets {
    display: grid;
    list-style: none;
    margin: var(--space-300) 0 0;
    max-height: 20rem;
    overflow: auto;
    padding: 0;
  }

  .target {
    cursor: pointer;
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
  }

  .actions {
    display: flex;
    gap: var(--space-1);
    justify-content: flex-end;
    margin-top: var(--space-300);
  }
</style>
