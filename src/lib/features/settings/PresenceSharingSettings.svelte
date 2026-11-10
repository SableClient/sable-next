<script lang="ts">
  import type { PresenceSharingEdit, PresenceUserSharingView } from '#src/generated/protocol';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { i18n } from '#lib/i18n.js';
  import { presenceSharing } from '#lib/rooms/presence-sharing.svelte.js';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsAnchorLink from '#lib/ui/primitives/SettingsAnchorLink.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import '#lib/ui/primitives/settings-row.css';

  const roomList = useRoomList();
  const localId = $props.id();

  let userDraft = $state('');
  let userChoice = $state<PresenceUserSharingView>('allow');
  let serverDraft = $state('');
  let busy = $state(false);

  const view = $derived(presenceSharing.view);
  const userId = $derived(userDraft.trim());
  const server = $derived(serverDraft.trim().toLowerCase());
  const validUser = $derived(/^@[^:\s]+:\S+$/.test(userId));
  const validServer = $derived(/^[a-z0-9.:[\]-]+$/.test(server) && !server.startsWith('@'));
  const people = $derived(
    view === null
      ? []
      : [
          ...view.allowed_users.map((id) => ({ id, sharing: 'allow' as const })),
          ...view.denied_users.map((id) => ({ id, sharing: 'deny' as const })),
        ].sort((a, b) => a.id.localeCompare(b.id))
  );
  const userChoices = $derived(
    (['allow', 'deny'] as const).map((value) => ({
      value,
      label: i18n.t(`settings.presenceSharingUser.${value}`),
    }))
  );

  async function apply(edit: PresenceSharingEdit): Promise<boolean> {
    busy = true;
    try {
      await presenceSharing.edit(edit);
      return true;
    } catch (error) {
      console.warn('[sable settings] presence sharing not saved', error);
      toasts.error(i18n.t('errors.actionFailed'));
      return false;
    } finally {
      busy = false;
    }
  }

  async function addUser(): Promise<void> {
    if (!validUser) return;
    if (await apply({ kind: 'user', user_id: userId, sharing: userChoice })) userDraft = '';
  }

  async function addServer(): Promise<void> {
    if (!validServer) return;
    if (await apply({ kind: 'server', server, denied: true })) serverDraft = '';
  }

  function roomName(roomId: string): string {
    return findRoomByPathId(roomList.rooms, roomId)?.display_name ?? roomId;
  }
</script>

{#snippet entries(
  ids: readonly string[],
  label: (id: string) => string,
  remove: (id: string) => PresenceSharingEdit
)}
  {#if ids.length === 0}
    <p class="settings-empty">{i18n.t('settings.presenceSharingEmpty')}</p>
  {:else}
    <ul class="settings-item-list">
      {#each ids as id (id)}
        <li>
          <span class="settings-item-text">{label(id)}</span>
          <IconButton
            variant="subtle"
            size="large"
            disabled={busy}
            label={i18n.t('settings.presenceSharingRemove', { name: label(id) })}
            onclick={() => void apply(remove(id))}
          >
            <TrashIcon />
          </IconButton>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#snippet heading(id: string, title: string, hint: string)}
  <div class="settings-heading-row">
    <h3 {id} data-settings-outline>{title}</h3>
    <SettingsAnchorLink anchor={id} />
  </div>
  <p class="settings-description">{hint}</p>
{/snippet}

{#if view}
  <div class="presence-sharing">
    <p class="settings-description">{i18n.t('settings.presenceSharingHint')}</p>

    {#if !view.configured}
      <Alert variant="info" role="status">
        <p>{i18n.t('settings.presenceSharingUnconfigured')}</p>
      </Alert>
    {/if}

    <ul class="settings-rows">
      <SettingsRow
        id="presence-share-locally"
        title={i18n.t('settings.presenceShareLocally')}
        description={i18n.t('settings.presenceShareLocallyHint')}
        control={localId}
      >
        <Switch
          id={localId}
          checked={view.share_locally}
          disabled={busy}
          label={i18n.t('settings.presenceShareLocally')}
          onCheckedChange={(enabled) => void apply({ kind: 'share_locally', enabled })}
        />
      </SettingsRow>
    </ul>

    <section class="settings-form" aria-labelledby="presence-people">
      {@render heading(
        'presence-people',
        i18n.t('settings.presenceSharingUsers'),
        i18n.t('settings.presenceSharingUsersHint')
      )}
      {#if people.length === 0}
        <p class="settings-empty">{i18n.t('settings.presenceSharingEmpty')}</p>
      {:else}
        <ul class="settings-item-list">
          {#each people as { id, sharing } (id)}
            <li>
              <span class="settings-item-text">{id}</span>
              <Select
                class="settings-item-control"
                aria-label={i18n.t('settings.presenceSharingUserFor', { name: id })}
                value={sharing}
                disabled={busy}
                items={userChoices}
                onValueChange={(value) => {
                  if (value !== sharing) {
                    void apply({
                      kind: 'user',
                      user_id: id,
                      sharing: value === 'deny' ? 'deny' : 'allow',
                    });
                  }
                }}
              />
              <IconButton
                variant="subtle"
                size="large"
                disabled={busy}
                label={i18n.t('settings.presenceSharingRemove', { name: id })}
                onclick={() => void apply({ kind: 'user', user_id: id, sharing: null })}
              >
                <TrashIcon />
              </IconButton>
            </li>
          {/each}
        </ul>
      {/if}
      <form
        class="add-row"
        onsubmit={(event) => {
          event.preventDefault();
          void addUser();
        }}
      >
        <TextInput
          bind:value={userDraft}
          aria-label={i18n.t('settings.presenceSharingUserLabel')}
          placeholder="@name:example.org"
          autocomplete="off"
          spellcheck="false"
        />
        <Select
          value={userChoice}
          aria-label={i18n.t('settings.presenceSharingUserChoice')}
          items={userChoices}
          onValueChange={(value) => {
            userChoice = value === 'deny' ? 'deny' : 'allow';
          }}
        />
        <Button type="submit" size="small" disabled={!validUser || busy}>
          <PlusIcon />
          {i18n.t('common.add')}
        </Button>
      </form>
    </section>

    <section class="settings-form" aria-labelledby="presence-rooms">
      {@render heading(
        'presence-rooms',
        i18n.t('settings.presenceSharingRooms'),
        i18n.t('settings.presenceSharingRoomsHint')
      )}
      {@render entries(view.allowed_rooms, roomName, (id) => ({
        kind: 'room',
        room_id: id,
        allowed: false,
      }))}
    </section>

    <section class="settings-form" aria-labelledby="presence-servers">
      {@render heading(
        'presence-servers',
        i18n.t('settings.presenceSharingServers'),
        i18n.t('settings.presenceSharingServersHint')
      )}
      {@render entries(
        view.denied_servers,
        (id) => id,
        (id) => ({ kind: 'server', server: id, denied: false })
      )}
      <form
        class="add-row"
        onsubmit={(event) => {
          event.preventDefault();
          void addServer();
        }}
      >
        <TextInput
          bind:value={serverDraft}
          aria-label={i18n.t('settings.presenceSharingServerLabel')}
          placeholder="example.org"
          autocomplete="off"
          spellcheck="false"
        />
        <Button type="submit" size="small" disabled={!validServer || busy}>
          <PlusIcon />
          {i18n.t('common.add')}
        </Button>
      </form>
    </section>
  </div>
{/if}

<style>
  .presence-sharing {
    display: grid;
    gap: var(--space-500);
  }

  .add-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-300);
  }

  @media (width >= 32rem) {
    .add-row {
      flex-direction: row;
    }

    .add-row :global(.text-input) {
      flex: 1;
      min-width: 0;
    }

    .add-row :global(.btn) {
      flex: none;
      white-space: nowrap;
    }
  }
</style>
