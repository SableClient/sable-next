<script lang="ts">
  import type { PublicRoomView } from '#src/generated/protocol';
  import { SvelteSet } from 'svelte/reactivity';

  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { goto } from '$app/navigation';
  import { runtimeConfig } from '#lib/config/runtime-config.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { joinRoom, knockRoom } from '#lib/core/api/rooms.js';
  import { userIdServer } from '#lib/features/auth/login/login-identifier.js';
  import { i18n } from '#lib/i18n.js';
  import { joinErrorMessage } from '#lib/rooms/join-errors.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import EmptyState from '#lib/ui/primitives/EmptyState.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Pill from '#lib/ui/primitives/Pill.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import SearchField from '#lib/ui/primitives/SearchField.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import {
    addServer,
    exploreServers,
    isServerName,
    readAddedServers,
    removeServer,
  } from './explore-servers.js';
  import { RoomDirectory } from './room-directory.svelte.js';
  import { lobbyAction } from '../spaces/space-hierarchy';

  const core = useCoreClient();
  const roomList = useRoomList();
  const directory = new RoomDirectory(core.rpc.rooms);
  const joining = new SvelteSet<string>();
  const knocked = new SvelteSet<string>();

  let search = $state('');
  let server = $state<string | null>(null);
  let featured = $state.raw<string[]>([]);
  let added = $state.raw<string[]>([]);
  let adding = $state(false);
  let newServer = $state('');
  let serverError = $state<string | null>(null);
  let kind = $state<'all' | 'rooms' | 'spaces'>('all');
  let failedJoin = $state<string | null>(null);

  let joinedIds = $derived(
    new Set(roomList.rooms.filter((room) => room.state === 'joined').map((room) => room.room_id))
  );
  let invitedIds = $derived(
    new Set(roomList.rooms.filter((room) => room.state === 'invited').map((room) => room.room_id))
  );

  let ownServer = $derived(userIdServer(core.session?.user_id ?? ''));
  let servers = $derived(exploreServers(ownServer, featured, added));

  $effect(() => {
    void directory.search({ server: null, search: '' });
    void runtimeConfig().then((config) => {
      featured = config.exploreServers;
    });
    readAddedServers(core.rpc.account)
      .then((servers) => {
        added = servers;
      })
      .catch((error: unknown) => {
        console.warn('[sable directory] added servers are unavailable', error);
      });
  });

  function browse(name: string): void {
    server = name === ownServer ? null : name;
    runSearch();
  }

  async function saveServer(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = newServer.trim();
    if (!isServerName(name)) {
      serverError = 'room.directoryInvalidServer';
      return;
    }
    serverError = null;
    added = await addServer(core.rpc.account, name);
    adding = false;
    newServer = '';
    browse(name);
  }

  async function forgetServer(name: string): Promise<void> {
    added = await removeServer(core.rpc.account, name);
    if (server !== name) return;
    server = null;
    runSearch();
  }

  function runSearch(): void {
    void directory.search({
      server,
      search: search.trim(),
      roomType: kind === 'all' ? null : kind,
    });
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    runSearch();
  }

  function label(room: PublicRoomView): string {
    return room.name ?? room.canonical_alias ?? room.room_id;
  }

  async function open(room: PublicRoomView): Promise<void> {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
    await goto(roomSectionPath(roomList.rooms, room.room_id));
  }

  async function join(room: PublicRoomView): Promise<void> {
    if (joining.has(room.room_id)) return;
    const address = room.canonical_alias ?? room.room_id;
    const via = directory.query.server === null ? [] : [directory.query.server];
    const knocking = lobbyAction(room.join_rule, invitedIds.has(room.room_id)) === 'knock';

    joining.add(room.room_id);
    failedJoin = null;
    try {
      if (knocking) {
        await knockRoom(core.rpc, address, via);
        knocked.add(room.room_id);
        return;
      }

      const roomId = await joinRoom(core.rpc, address, via);
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
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
  <div class="servers" role="group" aria-label={i18n.t('room.directoryServerLabel')}>
    {#each servers as name (name)}
      {@const selected = (server ?? ownServer) === name}
      <span class="server">
        <Pill
          variant={selected ? 'primary' : 'outline'}
          aria-pressed={selected}
          onclick={() => {
            browse(name);
          }}>{name}</Pill
        >
        {#if added.includes(name) && name !== ownServer}
          <IconButton
            variant="ghost"
            size="small"
            label={i18n.t('room.directoryRemoveServer', { server: name })}
            onclick={() => {
              forgetServer(name).catch((error: unknown) => {
                console.warn('[sable directory] the server was not removed', error);
              });
            }}
          >
            <XIcon />
          </IconButton>
        {/if}
      </span>
    {/each}
    {#if adding}
      <form
        class="add-server"
        onsubmit={(event) => {
          saveServer(event).catch((error: unknown) => {
            console.warn('[sable directory] the server was not saved', error);
          });
        }}
      >
        <TextInput
          bind:value={newServer}
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          aria-label={i18n.t('room.directoryAddServerLabel')}
          placeholder="example.org"
        />
        <Button type="submit" size="small">{i18n.t('common.add')}</Button>
        <Button
          variant="ghost"
          size="small"
          onclick={() => {
            adding = false;
            newServer = '';
            serverError = null;
          }}>{i18n.t('common.cancel')}</Button
        >
      </form>
    {:else}
      <Pill
        onclick={() => {
          adding = true;
        }}><PlusIcon size={14} />{i18n.t('room.directoryAddServer')}</Pill
      >
    {/if}
  </div>
  {#if serverError}
    <Alert variant="critical" role="alert">{i18n.t(serverError)}</Alert>
  {/if}

  <form class="filters" onsubmit={submit}>
    <SearchField
      bind:value={search}
      label={i18n.t('room.directorySearchLabel')}
      placeholder={i18n.t('common.searchRooms')}
    />
    <Select
      class="directory-kind"
      value={kind}
      aria-label={i18n.t('room.directoryKind')}
      items={[
        { value: 'all', label: i18n.t('room.directoryKindAll') },
        { value: 'rooms', label: i18n.t('room.directoryKindRooms') },
        { value: 'spaces', label: i18n.t('room.directoryKindSpaces') },
      ]}
      onValueChange={(next) => {
        kind = next === 'rooms' || next === 'spaces' ? next : 'all';
        runSearch();
      }}
    />
    <Button type="submit" variant="primary" loading={directory.loading}>
      <MagnifyingGlassIcon size={16} />{i18n.t('room.directorySearch')}
    </Button>
  </form>

  {#if directory.total !== null}
    <p class="count">{i18n.t('room.directoryTotal', { count: directory.total })}</p>
  {/if}

  {#if directory.error}
    <Alert variant="critical" role="alert">{i18n.t(directory.error)}</Alert>
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
          <Avatar id={room.room_id} src={room.avatar_url} name={label(room)} size="small" />
          <div class="room-text">
            <span class="room-name">
              {label(room)}
              {#if room.room_kind === 'space'}<span class="badge">{i18n.t('nav.space')}</span>{/if}
              {#if room.room_kind === 'voice'}<span class="badge">{i18n.t('common.voiceRoom')}</span
                >{/if}
            </span>
            <span class="room-meta">
              <span class="members"
                >{i18n.t('room.lobbyMembers', { count: room.num_joined_members })}</span
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
                label={i18n.t('room.lobbyOpen')}
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
                <PlusIcon size={14} />{i18n.t(
                  knocked.has(room.room_id)
                    ? 'room.lobbyKnockSent'
                    : action === 'knock'
                      ? 'common.askToJoin'
                      : 'common.join'
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
        {i18n.t('common.loadMore')}
      </Button>
    {/if}
  {:else if directory.loading}
    <div class="loading"><Spinner label={i18n.t('a11y.loading')} /></div>
  {:else if !directory.error}
    <EmptyState
      title={i18n.t('room.directoryEmptyTitle')}
      description={i18n.t('room.directoryEmptyBody')}
    />
  {/if}
</section>

<style>
  .directory {
    display: grid;
    gap: var(--space-500);
    margin-top: var(--space-500);
  }

  .filters {
    align-items: end;
    display: grid;
    gap: var(--space-300);
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .servers {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .server {
    align-items: center;
    display: inline-flex;
  }

  .add-server {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  @media (width < 40rem) {
    .filters {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .count {
    color: var(--surface-var-on-container);
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
    background: var(--surface-var-container);
    color: var(--surface-var-on-container);
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
    color: var(--surface-var-on-container);
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
    background: var(--surface-var-container);
    border-radius: var(--radius-pill);
    color: var(--surface-var-on-container);
    flex: none;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    padding: 0 var(--space-150);
  }

  .divider {
    color: var(--surface-var-container-line);
  }

  .loading {
    display: flex;
    justify-content: center;
    padding: var(--space-500);
  }
</style>
