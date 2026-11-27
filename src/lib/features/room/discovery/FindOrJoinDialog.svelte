<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onDestroy, untrack } from 'svelte';

  import type { RoomPreviewView, UserDirectoryEntryView } from '#src/generated/protocol';

  import { openDirectMessage } from '#lib/core/api/rooms.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { isUserId } from '#lib/guards.js';
  import { i18n } from '#lib/i18n.js';
  import { findOrJoinState } from '#lib/ui/find-or-join-state.svelte.js';
  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
  import { parseJoinAddress } from '#lib/rooms/join-address.js';
  import { joinErrorMessage } from '#lib/rooms/join-errors.js';
  import { joinOrKnockPath, joinOrOfferKnock, knockPagePath } from '#lib/rooms/join-or-knock.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { roomPathParamFromId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ResponsiveDialog from '#lib/ui/primitives/ResponsiveDialog.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { isComposingKey } from '#lib/ui/shortcuts/binding.js';

  import { UserDirectoryLookup } from '../members/user-directory-lookup.svelte.js';
  import UserSuggestionList from '../members/UserSuggestionList.svelte';
  import '#lib/ui/primitives/dialog-body.css';

  const core = useCoreClient();
  const roomList = useRoomList();
  const directory = new UserDirectoryLookup(core);
  const inputId = $props.id();
  const listId = `${inputId}-people`;

  let value = $state('');
  let preview = $state<RoomPreviewView | null>(null);
  let previewing = $state(false);
  let busy = $state(false);
  let failed = $state<string | null>(null);
  let suggestionList = $state<UserSuggestionList>();

  let room = $derived(parseJoinAddress(value) ?? null);
  let roomKey = $derived(room ? JSON.stringify([room.address, room.via]) : null);
  let term = $derived(room ? '' : value.trim());
  let people = $derived.by<UserDirectoryEntryView[]>(() => {
    if (!isUserId(term) || directory.results.some((entry) => entry.user_id === term)) {
      return directory.results;
    }
    const typed = {
      user_id: term,
      display_name: null,
      avatar_url: null,
      real_name: null,
      real_avatar_url: null,
    };
    return [typed, ...directory.results];
  });
  let listed = $derived(!room && people.length > 0);
  let knock = $derived(preview?.join_rule === 'knock' || preview?.join_rule === 'knock_restricted');
  let joined = $derived(preview?.state === 'joined');
  let actionLabel = $derived(
    joined ? i18n.t('findOrJoin.open') : knock ? i18n.t('common.askToJoin') : i18n.t('common.join')
  );

  $effect(() => {
    if (!findOrJoinState.open) return;
    untrack(() => {
      value = findOrJoinState.initial;
      failed = null;
    });
  });

  $effect(() => {
    directory.search(term);
  });

  $effect(() => {
    const key = roomKey;
    preview = null;
    failed = null;
    previewing = key !== null;
    if (key === null) return;

    const [address, via] = JSON.parse(key) as [string, string[]];
    let current = true;
    const timer = setTimeout(() => {
      core.rpc.rooms
        .preview({ address, via })
        .then((next) => {
          if (current) preview = next;
        })
        .catch((error: unknown) => {
          console.debug('[sable room] preview unavailable', error);
        })
        .finally(() => {
          if (current) previewing = false;
        });
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  });

  onDestroy(() => {
    directory.cancel();
  });

  async function leaveTo(target: string): Promise<void> {
    findOrJoinState.open = false;
    await afterOverlayPops();
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- every caller passes a resolved path
    await goto(target);
  }

  async function enterRoom(): Promise<void> {
    if (!room || busy || previewing) return;
    if (joined && preview) {
      await leaveTo(roomSectionPath(roomList.rooms, preview.room_id));
      return;
    }
    if (knock) {
      await leaveTo(knockPagePath(room.address, room.via));
      return;
    }

    busy = true;
    failed = null;
    try {
      await leaveTo(joinOrKnockPath(await joinOrOfferKnock(core.rpc, room.address, room.via)));
    } catch (error) {
      console.warn('[sable room] join failed', error);
      failed = joinErrorMessage(error);
    } finally {
      busy = false;
    }
  }

  async function message(userId: string): Promise<void> {
    if (busy) return;
    busy = true;
    failed = null;
    try {
      const roomId = await openDirectMessage(core, userId);
      await leaveTo(resolve('/(app)/direct/[roomId]', { roomId: roomPathParamFromId(roomId) }));
    } catch (error) {
      console.warn('[sable direct] could not open the chat', error);
      failed = i18n.t('direct.failed');
    } finally {
      busy = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (isComposingKey(event) || suggestionList?.handleKey(event)) return;
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (room) void enterRoom();
    else if (people[0]) void message(people[0].user_id);
  }
</script>

<ResponsiveDialog
  bind:open={findOrJoinState.open}
  label={i18n.t('nav.findOrJoin')}
  closeLabel={i18n.t('common.close')}
>
  {#snippet children(desktop)}
    <div class={['dialog-body', 'find-or-join', { sheet: !desktop }]}>
      <h2>{i18n.t('nav.findOrJoin')}</h2>

      <TextInput
        id={inputId}
        bind:value
        onkeydown={onKeydown}
        role="combobox"
        aria-expanded={listed}
        aria-controls={listed ? listId : undefined}
        aria-activedescendant={suggestionList?.activeOptionId()}
        aria-autocomplete="list"
        aria-label={i18n.t('nav.findOrJoin')}
        placeholder={i18n.t('findOrJoin.placeholder')}
        autocomplete="off"
        autocapitalize="none"
        spellcheck={false}
      />

      {#if room}
        <div class="room">
          {#if previewing}
            <div class="pending" role="status"><Spinner /></div>
          {:else if preview}
            {@const name = preview.name ?? preview.canonical_alias ?? room.address}
            <Avatar id={preview.room_id} src={preview.avatar_url} {name} />
            <div class="identity">
              <span class="name">{name}</span>
              {#if preview.canonical_alias}<span class="detail">{preview.canonical_alias}</span
                >{/if}
              {#if preview.num_joined_members != null}
                <span class="detail">
                  {i18n.t('join.members', { count: preview.num_joined_members })}
                </span>
              {/if}
              {#if preview.topic}<span class="topic">{preview.topic}</span>{/if}
            </div>
          {:else}
            <p class="note">{i18n.t('findOrJoin.previewUnavailable', { address: room.address })}</p>
          {/if}
        </div>
      {:else if people.length > 0}
        <UserSuggestionList
          bind:this={suggestionList}
          id={listId}
          entries={people}
          disabled={busy}
          onSelect={(userId) => {
            void message(userId);
          }}
        />
      {:else if term !== '' && !directory.searching}
        <p class="note">{i18n.t('findOrJoin.noPeople')}</p>
      {:else if term === ''}
        <p class="note">{i18n.t('findOrJoin.hint')}</p>
      {/if}

      {#if failed}
        <Alert variant="critical" role="alert">{failed}</Alert>
      {/if}

      <footer>
        <Button
          variant="ghost"
          size="small"
          onclick={() => {
            void leaveTo(resolve('explore'));
          }}
        >
          {i18n.t('findOrJoin.explore')}
        </Button>
        {#if room}
          <Button
            variant="primary"
            loading={busy}
            disabled={previewing}
            onclick={() => {
              void enterRoom();
            }}
          >
            {actionLabel}
          </Button>
        {/if}
      </footer>
    </div>
  {/snippet}
</ResponsiveDialog>

<style>
  .find-or-join {
    gap: var(--space-400);
    width: min(26rem, calc(100vw - 2rem));
  }

  .find-or-join.sheet {
    padding: 0 var(--space-400);
    width: auto;
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .room {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    min-height: var(--control-height-500);
  }

  .pending {
    display: flex;
    flex: 1;
    justify-content: center;
  }

  .identity {
    display: grid;
    min-width: 0;
  }

  .name,
  .detail,
  .topic {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name {
    font-weight: var(--font-weight-500);
  }

  .detail,
  .topic,
  .note {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .note {
    margin: 0;
  }

  footer {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    justify-content: space-between;
  }
</style>
