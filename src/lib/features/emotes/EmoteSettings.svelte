<script lang="ts">
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';

  import type { ImagePackView } from '#src/generated/ImagePackView';

  import { useCoreClient } from '#lib/core/context.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';

  import ImagePackEditor from './ImagePackEditor.svelte';
  import PersonalPackSettings from './PersonalPackSettings.svelte';
  import {
    EMOTE_ROOMS_EVENT_TYPE,
    IMAGE_PACK_ROOMS_EVENT_TYPE,
    packAddressEqual,
    packAddressKey,
    type PackAddress,
  } from './pack-address.js';
  import {
    emoteRoomsEventContent,
    readEmoteRooms,
    selectedAddresses,
    withSelection,
    type EmoteRoomsContent,
  } from './emote-rooms.js';

  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();
  const roomList = useRoomList();

  let packs = $state.raw<ImagePackView[]>([]);
  let selection = $state.raw<EmoteRoomsContent>({});
  let loading = $state(true);
  let busy = $state(false);
  let failed = $state(false);
  let viewing = $state<string | null>(null);
  let alive = true;

  let roomPacks = $derived(packs.filter((pack) => pack.origin === 'room' && pack.room_id !== null));
  let chosen = $derived(selectedAddresses(selection));
  let viewingPack = $derived(
    roomPacks.find((pack) => pack.room_id !== null && packAddressKey(address(pack)) === viewing) ??
      null
  );

  function address(pack: ImagePackView): PackAddress {
    return { roomId: pack.room_id ?? '', stateKey: pack.id };
  }

  function isChosen(pack: ImagePackView): boolean {
    return chosen.some((entry) => packAddressEqual(entry, address(pack)));
  }

  function roomName(roomId: string): string {
    const room = roomList.rooms.find((candidate) => candidate.room_id === roomId);
    return room?.name ?? room?.canonical_alias ?? roomId;
  }

  let byRoom = $derived(
    Object.entries(
      roomPacks.reduce<Record<string, ImagePackView[]>>((grouped, pack) => {
        const roomId = pack.room_id ?? '';
        return { ...grouped, [roomId]: [...(grouped[roomId] ?? []), pack] };
      }, {})
    ).toSorted(([left], [right]) => roomName(left).localeCompare(roomName(right)))
  );

  $effect(() => {
    void load().finally(() => {
      if (alive) loading = false;
    });

    return () => {
      alive = false;
    };
  });

  async function load(): Promise<void> {
    try {
      const [loaded, stable, unstable] = await Promise.all([
        core.commands.allImagePacks(),
        core.commands.accountData(IMAGE_PACK_ROOMS_EVENT_TYPE),
        core.commands.accountData(EMOTE_ROOMS_EVENT_TYPE),
      ]);
      if (!alive) return;
      packs = loaded;
      const chosenStable = readEmoteRooms(stable);
      selection = Object.keys(chosenStable).length > 0 ? chosenStable : readEmoteRooms(unstable);
    } catch (error) {
      console.warn('[sable emotes] the pack list could not be read', error);
      if (alive) failed = true;
    }
  }

  async function toggle(pack: ImagePackView, wanted: boolean): Promise<void> {
    const target = address(pack);
    const next = wanted
      ? withSelection(selection, [target], [])
      : withSelection(selection, [], [target]);

    busy = true;
    failed = false;
    try {
      await core.commands.setAccountData(IMAGE_PACK_ROOMS_EVENT_TYPE, emoteRoomsEventContent(next));
      selection = next;
    } catch (error) {
      console.warn('[sable emotes] the pack selection could not be saved', error);
      failed = true;
    } finally {
      busy = false;
    }
  }

  async function toggleRoom(roomId: string, roomsPacks: ImagePackView[]): Promise<void> {
    const all = roomsPacks.every(isChosen);
    const addresses = roomsPacks.map(address);
    const next = all
      ? withSelection(selection, [], addresses)
      : withSelection(selection, addresses, []);

    busy = true;
    failed = false;
    try {
      await core.commands.setAccountData(IMAGE_PACK_ROOMS_EVENT_TYPE, emoteRoomsEventContent(next));
      selection = next;
    } catch (error) {
      console.warn('[sable emotes] the pack selection could not be saved', error);
      failed = true;
    } finally {
      busy = false;
    }
    void roomId;
  }
</script>

<AppPageShell
  title={$i18n.t('settings.emotes')}
  description={$i18n.t('emotes.pageDescription')}
  density="compact"
  class="emote-settings-page"
>
  <div class="emote-settings">
    {#if failed}
      <Alert variant="critical" role="alert">{$i18n.t('emotes.saveFailed')}</Alert>
    {/if}

    {#if viewingPack}
      <div class="viewer-header">
        <Button
          size="small"
          onclick={() => {
            viewing = null;
          }}
        >
          <ArrowLeftIcon />
          {$i18n.t('emotes.back')}
        </Button>
      </div>
      {#key viewing}
        <ImagePackEditor pack={viewingPack} canEdit={false} />
      {/key}
    {:else}
      <PersonalPackSettings />

      <SettingsSection
        headingId="emote-room-packs"
        title={$i18n.t('emotes.roomPacksTitle')}
        description={$i18n.t('emotes.roomPacksHint')}
      >
        {#if loading}
          <p class="status" role="status"><Spinner small /></p>
        {:else if byRoom.length === 0}
          <p class="status">{$i18n.t('emotes.noRoomPacks')}</p>
        {:else}
          {#each byRoom as [roomId, roomsPacks] (roomId)}
            <div class="room-group">
              <div class="room-heading">
                <span>{roomName(roomId)}</span>
                <Button
                  size="small"
                  disabled={busy}
                  onclick={() => {
                    void toggleRoom(roomId, roomsPacks);
                  }}
                >
                  {roomsPacks.every(isChosen)
                    ? $i18n.t('emotes.unselectAll')
                    : $i18n.t('emotes.selectAll')}
                </Button>
              </div>
              <ul class="settings-rows">
                {#each roomsPacks as pack (pack.id)}
                  <SettingsRow
                    title={pack.name ?? pack.id}
                    description={$i18n.t('emotes.imageCount', { count: pack.images.length })}
                  >
                    {#snippet before()}
                      <MediaImage
                        source={pack.avatar_url ?? pack.images[0]?.url ?? ''}
                        alt=""
                        width={24}
                        height={24}
                      />
                    {/snippet}
                    <Button
                      size="small"
                      onclick={() => {
                        viewing = packAddressKey(address(pack));
                      }}
                    >
                      {$i18n.t('emotes.view')}
                    </Button>
                    <Switch
                      label={$i18n.t('emotes.useEverywhere', { name: pack.name ?? pack.id })}
                      checked={isChosen(pack)}
                      disabled={busy}
                      onCheckedChange={(checked) => {
                        void toggle(pack, checked);
                      }}
                    />
                  </SettingsRow>
                {/each}
              </ul>
            </div>
          {/each}
        {/if}
      </SettingsSection>
    {/if}
  </div>
</AppPageShell>

<style>
  :global(.app-page-shell.emote-settings-page) {
    max-width: 56rem;
  }

  .emote-settings {
    display: grid;
    gap: var(--space-300);
  }

  .viewer-header {
    display: flex;
  }

  .room-group {
    display: grid;
    gap: var(--space-100);
  }

  .room-heading {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    justify-content: space-between;
    padding: var(--space-200) var(--space-300) 0;
  }

  .status {
    color: var(--sable-surface-var-on-container);
    margin: 0;
    padding: var(--space-400) 0;
    text-align: center;
  }
</style>
