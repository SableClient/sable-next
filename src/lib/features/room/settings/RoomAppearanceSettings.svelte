<script lang="ts">
  import type { MediaPreviewsView, RoomListItemView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import {
    hasRoomMediaPreviews,
    useRoomMediaPreviews,
  } from '#lib/features/room/media/room-media-previews.svelte.js';
  import { mediaPreviewSettings } from '#lib/settings/media-previews.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import type { ShowRoomIcon } from '#lib/settings/definitions.js';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';

  import { isBridgedSpace, setBridgedSpace } from '#lib/rooms/bridged-spaces.svelte.js';
  import { roomIconOverride, setRoomIconOverride } from '#lib/rooms/room-appearance.svelte.js';

  import '#lib/ui/primitives/settings-row.css';

  const DEFAULT = 'default';

  interface Props {
    room: RoomListItemView | null;
  }

  let { room }: Props = $props();

  let roomId = $derived(room?.room_id ?? null);
  let value = $derived(roomIconOverride(roomId) ?? DEFAULT);
  let options = $derived([
    {
      value: DEFAULT,
      label: i18n.t('room.appearanceIconDefault', {
        mode: i18n.t(`settings.showRoomIcon${label(preferences.showRoomIcon)}`),
      }),
    },
    { value: 'always', label: i18n.t('common.always') },
    { value: 'sometimes', label: i18n.t('settings.showRoomIconSometimes') },
    { value: 'collapsed', label: i18n.t('settings.showRoomIconCollapsed') },
    { value: 'never', label: i18n.t('common.never') },
  ]);

  function label(mode: ShowRoomIcon): string {
    return `${mode.slice(0, 1).toLocaleUpperCase()}${mode.slice(1)}`;
  }

  function select(next: string): void {
    const target = roomId;
    if (!target) return;
    setRoomIconOverride(target, next === DEFAULT ? null : (next as ShowRoomIcon));
  }

  const MEDIA_LABELS: Record<MediaPreviewsView, string> = {
    on: 'settings.mediaAutoLoadAll',
    private: 'settings.mediaAutoLoadPrivate',
    off: 'common.never',
  };
  const openRoomMedia = hasRoomMediaPreviews() ? useRoomMediaPreviews() : null;
  let roomMedia = $state<MediaPreviewsView | null>(null);
  let mediaOptions = $derived([
    {
      value: DEFAULT,
      label: i18n.t('room.appearanceIconDefault', {
        mode: i18n.t(MEDIA_LABELS[mediaPreviewSettings.mediaPreviews]),
      }),
    },
    { value: 'on', label: i18n.t('common.always') },
    ...(roomMedia === 'private'
      ? [{ value: 'private', label: i18n.t('settings.mediaAutoLoadPrivate') }]
      : []),
    { value: 'off', label: i18n.t('common.never') },
  ]);

  $effect(() => {
    const target = roomId;
    if (!target) return;
    let stale = false;
    mediaPreviewSettings
      .roomConfig(target)
      .then((config) => {
        if (!stale) roomMedia = config.media_previews ?? null;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] room media settings unavailable', error);
      });
    return () => {
      stale = true;
    };
  });

  function selectMedia(next: string): void {
    const target = roomId;
    if (!target) return;
    const previews = next === DEFAULT ? null : (next as MediaPreviewsView);
    const previous = roomMedia;
    roomMedia = previews;
    mediaPreviewSettings
      .setRoom(target, previews)
      .then((config) => {
        if (openRoomMedia) openRoomMedia.room = config;
      })
      .catch(() => {
        roomMedia = previous;
        toasts.error(i18n.t('errors.actionFailed'));
      });
  }
</script>

<div class="section">
  <SettingsSection
    headingId="room-settings-appearance"
    title={i18n.t('room.appearanceVisualTweaks')}
    description={i18n.t('room.appearanceHint')}
  >
    <ul class="settings-rows">
      <SettingsRow
        title={i18n.t('room.appearanceIconTitle')}
        description={i18n.t('room.appearanceIconHint')}
      >
        <Select
          {value}
          aria-label={i18n.t('room.appearanceIconTitle')}
          items={options}
          onValueChange={select}
        />
      </SettingsRow>
      <SettingsRow
        title={i18n.t('room.appearanceBridgedTitle')}
        description={i18n.t('room.appearanceBridgedHint')}
      >
        <Switch
          checked={isBridgedSpace(roomId)}
          label={i18n.t('room.appearanceBridgedTitle')}
          onCheckedChange={(checked) => {
            if (roomId) setBridgedSpace(roomId, checked);
          }}
        />
      </SettingsRow>
      <SettingsRow title={i18n.t('room.mediaTitle')} description={i18n.t('room.mediaHint')}>
        <Select
          value={roomMedia ?? DEFAULT}
          aria-label={i18n.t('room.mediaTitle')}
          items={mediaOptions}
          onValueChange={selectMedia}
        />
      </SettingsRow>
    </ul>
  </SettingsSection>
</div>

<style>
  .section {
    display: grid;
    gap: var(--space-600);
  }
</style>
