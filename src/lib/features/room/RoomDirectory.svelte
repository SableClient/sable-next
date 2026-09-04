<script lang="ts">
  import type { PublicRoomView } from '#src/generated/PublicRoomView';
  import { SvelteSet } from 'svelte/reactivity';

  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';

  import { goto } from '$app/navigation';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { joinErrorMessage } from '#lib/rooms/join-errors.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import EmptyState from '#lib/ui/primitives/EmptyState.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { RoomDirectory } from './room-directory.svelte.js';
  import { lobbyAction } from './space-hierarchy';

  const core = useCoreClient();
  const roomList = useRoomList();
  const directory = new RoomDirectory(core.commands);
  const joining = new SvelteSet<string>();
  const knocked = new SvelteSet<string>();

  let search = $state('');
  let server = $state('');
  let failedJoin = $state<string | null>(null);

  let joinedIds = $derived(
    new Set(roomList.rooms.filter((room) => room.state === 'joined').map((room) => room.room_id))
  );
  let invitedIds = $derived(
    new Set(roomList.rooms.filter((room) => room.state === 'invited').map((room) => room.room_id))
  );

  $effect(() => {
    void directory.search({ server: null, search: '' });
  });

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const trimmed = server.trim();
    void directory.search({ server: trimmed === '' ? null : trimmed, search: search.trim() });
  }

  function label(room: PublicRoomView): string {
    return room.name ?? room.canonical_alias ?? room.room_id;
  }

  async function open(room: PublicRoomView): Promise<void> {
    await goto(roomSectionPath(roomList.rooms, room.room_id));
  }

  async function join(room: PublicRoomView): Promise<void> {
    if (joining.has(room.room_id)) return;
    const address = room.canonical_alias ?? room.room_id;
    const knocking = lobbyAction(room.join_rule, invitedIds.has(room.room_id)) === 'knock';

    joining.add(room.room_id);
    failedJoin = null;
    try {
      if (knocking) {
        await core.commands.knockRoom(address);
        knocked.add(room.room_id);
        return;
      }

      const roomId = await core.commands.joinRoom(address);
      await goto(roomSectionPath(roomList.rooms, roomId));
    } catch (error) {
      console.warn('[sable directory] join failed', error);
      failedJoin = joinErrorMessage(error);
    } finally {
      joining.delete(room.room_id);
    }
  }
</script>

<section class="directory">
  <form class="filters" onsubmit={submit}>
    <TextInput
      bind:value={search}
      type="search"
      autocomplete="off"
      aria-label={$i18n.t('room.directorySearchLabel')}
      placeholder={$i18n.t('room.directorySearchPlaceholder')}
    />
    <TextInput
      bind:value={server}
      autocomplete="off"
      autocapitalize="none"
      spellcheck={false}
      aria-label={$i18n.t('room.directoryServerLabel')}
      placeholder={$i18n.t('room.directoryServerPlaceholder')}
    />
    <Button type="submit" variant="primary" loading={directory.loading}>
      <MagnifyingGlassIcon size={16} />{$i18n.t('room.directorySearch')}
    </Button>
  </form>

  {#if directory.total !== null}
    <p class="count">{$i18n.t('room.directoryTotal', { count: directory.total })}</p>
  {/if}

  {#if directory.error}
    <Alert variant="critical" role="alert">{$i18n.t(directory.error)}</Alert>
  {/if}
  {#if failedJoin !== null}
    <Alert variant="critical" role="alert">{failedJoin}</Alert>
  {/if}

  {#if directory.rooms.length > 0}
    <ul class="rooms">
      {#each directory.rooms as room (room.room_id)}
        {@const joined = joinedIds.has(room.room_id)}
        {@const action = lobbyAction(room.join_rule, invitedIds.has(room.room_id))}
        <li class="room">
          <Avatar src={room.avatar_url} name={label(room)} size="small" />
          <div class="room-text">
            <span class="room-name">
              {label(room)}
              {#if room.is_space}<span class="badge">{$i18n.t('nav.space')}</span>{/if}
              {#if room.is_voice}<span class="badge">{$i18n.t('nav.voiceRoom')}</span>{/if}
            </span>
            <span class="room-meta">
              <span class="members"
                >{$i18n.t('room.lobbyMembers', { count: room.num_joined_members })}</span
              >
              {#if room.canonical_alias}
                <span class="divider" aria-hidden="true">|</span><span class="alias"
                  >{room.canonical_alias}</span
                >
              {/if}
            </span>
            {#if room.topic}<span class="room-topic">{room.topic}</span>{/if}
          </div>
          <div class="room-actions">
            {#if joined}
              <IconButton
                variant="ghost"
                size="small"
                label={$i18n.t('room.lobbyOpen')}
                onclick={() => {
                  void open(room);
                }}
              >
                <ArrowRightIcon />
              </IconButton>
            {:else if action}
              <Button
                size="small"
                disabled={knocked.has(room.room_id)}
                loading={joining.has(room.room_id)}
                onclick={() => {
                  void join(room);
                }}
              >
                <PlusIcon size={14} />{$i18n.t(
                  knocked.has(room.room_id)
                    ? 'room.lobbyKnockSent'
                    : action === 'knock'
                      ? 'room.lobbyKnock'
                      : 'room.lobbyJoin'
                )}
              </Button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    {#if directory.hasMore}
      <Button
        variant="ghost"
        loading={directory.loading}
        onclick={() => {
          void directory.loadMore();
        }}
      >
        {$i18n.t('room.directoryMore')}
      </Button>
    {/if}
  {:else if directory.loading}
    <div class="loading"><Spinner /></div>
  {:else if !directory.error}
    <EmptyState
      title={$i18n.t('room.directoryEmptyTitle')}
      description={$i18n.t('room.directoryEmptyBody')}
    />
  {/if}
</section>

<style>
  .directory {
    display: grid;
    gap: var(--space-500);
  }

  .filters {
    align-items: end;
    display: grid;
    gap: var(--space-300);
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) auto;
  }

  @media (width < 40rem) {
    .filters {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .count {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .rooms {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .room {
    align-items: center;
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-400);
    grid-template-columns: auto minmax(0, 1fr) auto;
    padding: var(--space-300);
  }

  .room:hover {
    background: var(--sable-surface-var-container);
  }

  .room-text {
    display: grid;
    gap: var(--space-050);
    min-width: 0;
  }

  .room-name {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .room-meta,
  .room-topic {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .room-meta {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .badge {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    flex: none;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    padding: 0 var(--space-150);
  }

  .divider {
    color: var(--sable-surface-var-container-line);
  }

  .loading {
    display: flex;
    justify-content: center;
    padding: var(--space-500);
  }
</style>
