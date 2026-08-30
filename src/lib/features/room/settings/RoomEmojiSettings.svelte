<script lang="ts">
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import type { ImagePackView } from '#src/generated/ImagePackView';
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';

  import { useCoreClient } from '#lib/core/context.js';
  import ImagePackEditor from '#lib/features/emotes/ImagePackEditor.svelte';
  import { ROOM_IMAGE_PACK_EVENT_TYPE } from '#lib/features/emotes/pack-address.js';
  import {
    packEventContent,
    uniqueShortcode,
    normalizeShortcode,
  } from '#lib/features/emotes/pack-content.js';
  import type { PackDraft } from '#lib/features/emotes/pack-content.js';
  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { canSendState } from './permission-groups';

  import '#lib/ui/primitives/settings-row.css';

  interface Props {
    room: RoomSummary | null;
    permissions: RoomPermissionsView | null;
    levels: RoomPowerLevelsView | null;
  }

  let { room, permissions, levels }: Props = $props();
  const core = useCoreClient();

  let packs = $state.raw<ImagePackView[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let busy = $state(false);
  let newPackName = $state('');
  let viewing = $state<string | null>(null);
  let run = 0;

  let roomId = $derived(room?.room_id ?? null);
  let canEdit = $derived(
    canSendState(levels, permissions?.own_power_level ?? 0, ROOM_IMAGE_PACK_EVENT_TYPE)
  );
  let roomPacks = $derived(packs.filter((pack) => pack.origin === 'room'));
  let viewingPack = $derived(roomPacks.find((pack) => pack.id === viewing) ?? null);

  $effect(() => {
    void roomId;
    void load();
  });

  async function load(): Promise<void> {
    const target = roomId;
    if (!target) return;

    const current = ++run;
    loading = true;
    failed = false;
    try {
      const loaded = await core.commands.imagePacks(target);
      if (current !== run) return;
      packs = loaded;
    } catch (error) {
      console.warn('[sable room] image packs unavailable', error);
      if (current === run) failed = true;
    } finally {
      if (current === run) loading = false;
    }
  }

  async function writePack(stateKey: string, content: unknown): Promise<void> {
    const target = roomId;
    if (!target) return;

    await core.commands.sendStateEvent(target, ROOM_IMAGE_PACK_EVENT_TYPE, stateKey, content);
    await load();
  }

  async function createPack(): Promise<void> {
    const name = newPackName.trim();
    if (name === '' || busy) return;

    const wanted = normalizeShortcode(name).toLocaleLowerCase() || 'pack';
    const stateKey = uniqueShortcode(wanted, (candidate) =>
      roomPacks.some((pack) => pack.id === candidate)
    );

    busy = true;
    failed = false;
    try {
      await writePack(stateKey, { pack: { display_name: name }, images: {} });
      newPackName = '';
    } catch (error) {
      console.warn('[sable room] pack creation failed', error);
      failed = true;
    } finally {
      busy = false;
    }
  }

  async function deletePack(pack: ImagePackView): Promise<void> {
    if (busy) return;

    busy = true;
    failed = false;
    try {
      await writePack(pack.id, {});
      if (viewing === pack.id) viewing = null;
    } catch (error) {
      console.warn('[sable room] pack removal failed', error);
      failed = true;
    } finally {
      busy = false;
    }
  }

  async function applyDraft(pack: ImagePackView, draft: PackDraft): Promise<void> {
    await writePack(pack.id, packEventContent(draft));
  }
</script>

<div class="section">
  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.emojisFailed')}</Alert>
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
    {#key viewingPack.id}
      <ImagePackEditor
        pack={viewingPack}
        {canEdit}
        onApply={(draft) => applyDraft(viewingPack, draft)}
      />
    {/key}
  {:else}
    {#if canEdit}
      <SettingsSection
        headingId="room-emojis-create"
        title={$i18n.t('room.emojisCreateTitle')}
        description={$i18n.t('room.emojisCreateHint')}
      >
        <div class="settings-form">
          <div class="inline">
            <TextInput
              bind:value={newPackName}
              placeholder={$i18n.t('room.emojisPackNamePlaceholder')}
              aria-label={$i18n.t('room.emojisPackName')}
            />
            <Button
              disabled={newPackName.trim() === '' || busy}
              onclick={() => {
                void createPack();
              }}
            >
              {$i18n.t('room.emojisCreate')}
            </Button>
          </div>
        </div>
      </SettingsSection>
    {/if}

    {#if loading && packs.length === 0}
      <p class="status" role="status"><Spinner small /></p>
    {:else if roomPacks.length === 0}
      <p class="status">{$i18n.t('room.emojisEmpty')}</p>
    {:else}
      <SettingsSection headingId="room-emojis-packs" title={$i18n.t('room.emojisPacks')}>
        <ul class="settings-rows">
          {#each roomPacks as pack (pack.id)}
            <SettingsRow
              title={pack.name ?? pack.id}
              description={$i18n.t('room.emojisPackCount', { count: pack.images.length })}
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
                  viewing = pack.id;
                }}
              >
                {$i18n.t('emotes.view')}
              </Button>
              {#if canEdit}
                <IconButton
                  variant="ghost"
                  size="small"
                  label={$i18n.t('room.emojisDeletePack', { name: pack.name ?? pack.id })}
                  disabled={busy}
                  onclick={() => {
                    void deletePack(pack);
                  }}
                >
                  <TrashIcon />
                </IconButton>
              {/if}
            </SettingsRow>
          {/each}
        </ul>
      </SettingsSection>
    {/if}
  {/if}
</div>

<style>
  .section {
    display: grid;
    gap: var(--space-300);
  }

  .viewer-header {
    display: flex;
  }

  .status {
    color: var(--sable-surface-var-on-container);
    margin: 0;
    padding: var(--space-400) 0;
    text-align: center;
  }

  .inline {
    display: grid;
    gap: var(--space-300);
    grid-template-columns: 1fr auto;
  }
</style>
