<script lang="ts">
  import type { ImagePackView } from '#src/generated/ImagePackView';
  import type { PackImageView } from '#src/generated/PackImageView';
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import { canSendState } from './permission-groups';

  import '#lib/ui/primitives/settings-row.css';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  const IMAGE_PACK_EVENT_TYPE = 'im.ponies.room_emotes';

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
  let shortcodes = $state<Record<string, string>>({});
  const fileInputs: Record<string, HTMLInputElement | null> = $state({});
  let run = 0;

  let roomId = $derived(room?.room_id ?? null);
  let canEdit = $derived(
    canSendState(levels, permissions?.own_power_level ?? 0, IMAGE_PACK_EVENT_TYPE)
  );
  let roomPacks = $derived(packs.filter((pack) => pack.origin === 'room'));

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

  function packContent(pack: ImagePackView, images: readonly PackImageView[]): unknown {
    return {
      pack: {
        display_name: pack.name,
        avatar_url: pack.avatar_url,
        attribution: pack.attribution,
      },
      images: Object.fromEntries(
        images.map((image) => [
          image.shortcode,
          { url: image.url, body: image.body, usage: image.usage },
        ])
      ),
    };
  }

  async function write(pack: ImagePackView, images: readonly PackImageView[]): Promise<void> {
    const target = roomId;
    if (!target) return;

    busy = true;
    failed = false;
    try {
      await core.commands.sendStateEvent(
        target,
        IMAGE_PACK_EVENT_TYPE,
        pack.id,
        packContent(pack, images)
      );
      await load();
    } catch (error) {
      console.warn('[sable room] pack change failed', error);
      failed = true;
    } finally {
      busy = false;
    }
  }

  async function createPack(): Promise<void> {
    const target = roomId;
    const name = newPackName.trim();
    if (!target || name === '' || busy) return;

    const stateKey = name
      .toLocaleLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '');
    busy = true;
    failed = false;
    try {
      await core.commands.sendStateEvent(target, IMAGE_PACK_EVENT_TYPE, stateKey || 'pack', {
        pack: { display_name: name },
        images: {},
      });
      newPackName = '';
      await load();
    } catch (error) {
      console.warn('[sable room] pack creation failed', error);
      failed = true;
    } finally {
      busy = false;
    }
  }

  function removeImage(pack: ImagePackView, shortcode: string): void {
    void write(
      pack,
      pack.images.filter((image) => image.shortcode !== shortcode)
    );
  }

  async function addImage(
    pack: ImagePackView,
    event: Event & { currentTarget: HTMLInputElement }
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    const shortcode = (shortcodes[pack.id] ?? '').trim();
    if (!file || shortcode === '' || busy) return;

    busy = true;
    failed = false;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const url = await core.commands.uploadMedia(file.type || 'image/*', bytes);
      shortcodes = { ...shortcodes, [pack.id]: '' };
      busy = false;
      await write(pack, [
        ...pack.images.filter((image) => image.shortcode !== shortcode),
        { shortcode, url, body: null, usage: ['emoticon', 'sticker'] },
      ]);
    } catch (error) {
      console.warn('[sable room] image upload failed', error);
      failed = true;
      busy = false;
    }
  }
</script>

<div class="section">
  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.emojisFailed')}</Alert>
  {/if}

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
    {#each roomPacks as pack (pack.id)}
      <SettingsSection
        headingId={`room-emojis-${pack.id}`}
        title={pack.name ?? pack.id}
        description={$i18n.t('room.emojisPackCount', { count: pack.images.length })}
      >
        {#if pack.images.length > 0}
          <ul class="settings-rows">
            {#each pack.images as image (image.shortcode)}
              <li class="settings-row">
                <MediaImage source={image.url} alt={image.shortcode} width={24} height={24} />
                <div class="settings-row-copy">
                  <span class="settings-row-name">:{image.shortcode}:</span>
                </div>
                {#if canEdit}
                  <div class="settings-row-control">
                    <IconButton
                      variant="ghost"
                      size="small"
                      label={$i18n.t('room.emojisRemove', { shortcode: image.shortcode })}
                      disabled={busy}
                      onclick={() => {
                        removeImage(pack, image.shortcode);
                      }}
                    >
                      <TrashIcon />
                    </IconButton>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if canEdit}
          <div class="settings-form">
            <div class="inline">
              <TextInput
                value={shortcodes[pack.id] ?? ''}
                placeholder={$i18n.t('room.emojisShortcodePlaceholder')}
                aria-label={$i18n.t('room.emojisShortcode')}
                oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
                  shortcodes = { ...shortcodes, [pack.id]: event.currentTarget.value };
                }}
              />
              <Button
                disabled={(shortcodes[pack.id] ?? '').trim() === '' || busy}
                onclick={() => fileInputs[pack.id]?.click()}
              >
                {$i18n.t('room.emojisAdd')}
              </Button>
            </div>
            <input
              bind:this={fileInputs[pack.id]}
              class="file-input"
              type="file"
              accept="image/*"
              tabindex="-1"
              aria-hidden="true"
              onchange={(event) => {
                void addImage(pack, event);
              }}
            />
          </div>
        {/if}
      </SettingsSection>
    {/each}
  {/if}
</div>

<style>
  .section {
    display: grid;
    gap: var(--space-300);
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

  .file-input {
    height: 0;
    opacity: 0;
    position: absolute;
    width: 0;
  }
</style>
