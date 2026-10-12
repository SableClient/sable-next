<script lang="ts">
  import type {
    FieldEdit,
    PronounView,
    RoomPermissionsView,
    RoomPowerLevelsView,
    RoomSummary,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import type { MemberLookEdit } from '#lib/core/commands.svelte.js';
  import { COSMETIC_EVENT_TYPES, pronounSets } from '#lib/features/composer/slash-commands.js';
  import ColorSetting from '#lib/features/settings/ColorSetting.svelte';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { uprightJpeg } from '#lib/ui/upright-jpeg.js';

  import { senderDisplayColors } from '../members/members';
  import SenderName from '../members/SenderName.svelte';
  import { canSendState } from './permission-groups';

  import '#lib/ui/primitives/settings-row.css';

  const MEMBER_LEVEL = 0;
  const MODERATOR_LEVEL = 50;

  interface Props {
    room: RoomSummary | null;
    permissions: RoomPermissionsView | null;
    levels: RoomPowerLevelsView | null;
  }

  let { room, permissions, levels }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const uid = $props.id();

  let roomId = $derived(room?.room_id ?? null);
  let userId = $derived(core.session?.user_id ?? null);
  let isSpace = $derived(room?.is_space ?? false);
  let ownLevel = $derived(permissions?.own_power_level ?? 0);
  let currentLevels = $state.raw<RoomPowerLevelsView | null>(null);
  let effectiveLevels = $derived(currentLevels ?? levels);

  let colorOnLight = $state('');
  let colorOnDark = $state('');
  let name = $state('');
  let savedName = $state('');
  let profileName = $state<string | null>(null);
  let avatar = $state<string | null>(null);
  let profileAvatar = $state<string | null>(null);
  let avatarInput = $state<HTMLInputElement | null>(null);
  let pronouns = $state('');
  let savedPronouns = $state('');
  let saving = $state<string | null>(null);
  let failed = $state(false);
  let applied = $state<{ done: number; failed: number; total: number } | null>(null);
  let run = 0;

  let canSetColor = $derived(canSendState(effectiveLevels, ownLevel, 'm.room.member'));
  let canSetPronouns = $derived(
    canSendState(effectiveLevels, ownLevel, COSMETIC_EVENT_TYPES.pronoun)
  );
  let applyTargets = $derived.by(() => {
    const found: string[] = [];
    const seen: string[] = [];
    const walk = (space: RoomSummary | undefined) => {
      for (const edge of space?.space_children ?? []) {
        if (seen.includes(edge.room_id)) continue;
        seen.push(edge.room_id);
        const child = roomList.byId(edge.room_id);
        if (child?.state !== 'joined') continue;
        if (child.is_space) walk(child);
        else found.push(child.room_id);
      }
    };
    if (room) {
      seen.push(room.room_id);
      walk(room);
    }
    return found;
  });
  let applyDescription = $derived.by(() => {
    if (saving === 'apply' && applied)
      return $i18n.t('room.cosmeticsApplying', {
        done: applied.done + applied.failed,
        total: applied.total,
      });
    if (applied?.failed)
      return $i18n.t('room.cosmeticsAppliedPartial', {
        count: applied.done,
        failed: applied.failed,
      });
    if (applied) return $i18n.t('room.cosmeticsApplied', { count: applied.done });
    if (applyTargets.length === 0) return $i18n.t('room.cosmeticsApplyRoomsNone');
    if (name !== savedName) return $i18n.t('room.cosmeticsApplyRoomsSaveFirst');
    return $i18n.t('room.cosmeticsApplyRoomsHint', { count: applyTargets.length });
  });
  let canManage = $derived(permissions?.can_change_power_levels ?? false);
  let membersSetPronouns = $derived(
    effectiveLevels?.events[COSMETIC_EVENT_TYPES.pronoun] === MEMBER_LEVEL
  );

  let previewPronouns = $derived<PronounView[]>(
    pronouns
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((summary) => ({ language: null, summary }))
  );
  let previewColors = $derived(
    senderDisplayColors(userId ?? '', null, null, false, {
      colorOnLight: colorOnLight || null,
      colorOnDark: colorOnDark || null,
      pronouns: previewPronouns,
    })
  );
  let previewName = $derived(name.trim() || profileName || userId || '');

  $effect(() => {
    const target = roomId;
    const self = userId;
    if (!target || !self) return;
    void load(target, self);
  });

  async function load(target: string, self: string): Promise<void> {
    const current = ++run;
    try {
      const [look, profile] = await Promise.all([
        core.commands.memberLook(target),
        core.refreshUserProfile(self).catch(() => null),
      ]);
      if (current !== run) return;
      colorOnLight = look.color_on_light ?? '';
      colorOnDark = look.color_on_dark ?? '';
      profileName = profile?.display_name ?? null;
      profileAvatar = profile?.avatar_url ?? null;
      avatar = look.avatar_url === profileAvatar ? null : look.avatar_url;
      name = look.display_name === profileName ? '' : (look.display_name ?? '');
      savedName = name;
      pronouns = look.pronouns.map((set) => set.summary).join(', ');
      savedPronouns = pronouns;
    } catch (error) {
      console.warn('[sable room] cosmetics unavailable', error);
    }
  }

  async function save(key: string, write: (target: string) => Promise<void>) {
    const target = roomId;
    const self = userId;
    if (!target || !self || saving !== null) return;
    saving = key;
    failed = false;
    try {
      await write(target);
    } catch (error) {
      console.warn('[sable room] cosmetic not saved', error);
      failed = true;
    } finally {
      saving = null;
    }
  }

  function saveColor(theme: 'on_light' | 'on_dark', value: string | undefined): void {
    const edit = field(value);
    void save(theme, (target) =>
      core.commands.setMemberLook(
        target,
        theme === 'on_light' ? { color_on_light: edit } : { color_on_dark: edit }
      )
    );
  }

  function field(value: string | null | undefined): FieldEdit {
    return value ? { kind: 'set', value } : { kind: 'clear' };
  }

  function writeMember(target: string, look: MemberLookEdit): Promise<void> {
    return core.commands.setMemberLook(target, look);
  }

  function saveName(): void {
    void save('name', async (target) => {
      const next = name.trim() || profileName;
      await writeMember(target, { display_name: field(next) });
      name = next === profileName ? '' : (next ?? '');
      savedName = name;
    });
  }

  function uploadAvatar(event: Event & { currentTarget: HTMLInputElement }): void {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    void save('avatar', async (target) => {
      const upright = await uprightJpeg(file);
      const bytes = new Uint8Array(await upright.arrayBuffer());
      const uri = await core.commands.uploadMedia(upright.type || 'image/*', bytes);
      await writeMember(target, { avatar_url: field(uri) });
      avatar = uri;
    });
  }

  function resetAvatar(): void {
    void save('avatar', async (target) => {
      await writeMember(target, { avatar_url: field(profileAvatar) });
      avatar = null;
    });
  }

  function applyToRooms(): void {
    const total = applyTargets.length;
    let progress = { done: 0, failed: 0, total };
    applied = progress;
    void save('apply', async () => {
      for (const child of applyTargets) {
        try {
          await writeMember(child, {
            display_name: field(name.trim() || profileName),
            avatar_url: field(avatar ?? profileAvatar),
          });
        } catch (error) {
          console.warn('[sable room] look not applied to a room', error);
          progress = { ...progress, failed: progress.failed + 1 };
          applied = progress;
          continue;
        }
        progress = { ...progress, done: progress.done + 1 };
        applied = progress;
      }
    });
  }

  function savePronouns(): void {
    void save('pronouns', async (target) => {
      await core.commands.setPronouns(target, pronounSets(pronouns));
      savedPronouns = pronouns;
    });
  }

  function resetLook(): void {
    void save('reset', async (target) => {
      const colored = colorOnLight !== '' || colorOnDark !== '';
      await writeMember(target, {
        display_name: field(profileName),
        avatar_url: field(profileAvatar),
        ...(colored && { color_on_light: field(null), color_on_dark: field(null) }),
      });
      name = '';
      savedName = '';
      avatar = null;
      if (colored) {
        colorOnLight = '';
        colorOnDark = '';
      }
      if (canSetPronouns && savedPronouns !== '') {
        await core.commands.setPronouns(target, []);
        pronouns = '';
        savedPronouns = '';
      }
    });
  }

  function allowMembers(eventType: string, allowed: boolean): void {
    const base = effectiveLevels;
    if (!base) return;
    void save(eventType, async (target) => {
      currentLevels = await core.commands.setPowerLevel(
        target,
        base,
        { kind: 'state', event_type: eventType },
        allowed ? MEMBER_LEVEL : MODERATOR_LEVEL
      );
    });
  }
</script>

<div class="section">
  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.settingsFailed')}</Alert>
  {/if}

  <SettingsSection
    headingId="room-settings-cosmetics"
    title={$i18n.t(isSpace ? 'room.cosmeticsTitleSpace' : 'room.cosmeticsTitleRoom')}
    description={$i18n.t(isSpace ? 'room.cosmeticsHintSpace' : 'room.cosmeticsHintRoom')}
  >
    <div class="preview" aria-hidden="true">
      <SenderName displayName={previewName} colors={previewColors} pronouns={previewPronouns} />
    </div>
    <ul class="settings-rows">
      <SettingsRow
        title={$i18n.t(isSpace ? 'room.cosmeticsAvatarSpace' : 'room.cosmeticsAvatar')}
        description={$i18n.t(
          isSpace ? 'room.cosmeticsAvatarHintSpace' : 'room.cosmeticsAvatarHint'
        )}
      >
        {#snippet before()}
          <Avatar id={userId} src={avatar ?? profileAvatar} name={previewName} />
        {/snippet}
        <Button size="small" disabled={saving !== null} onclick={() => avatarInput?.click()}>
          {$i18n.t('common.changePicture')}
        </Button>
        {#if avatar}
          <Button size="small" variant="ghost" disabled={saving !== null} onclick={resetAvatar}>
            {$i18n.t('room.cosmeticsAvatarReset')}
          </Button>
        {/if}
        <input
          bind:this={avatarInput}
          class="avatar-input"
          type="file"
          accept="image/*"
          tabindex="-1"
          aria-hidden="true"
          onchange={uploadAvatar}
        />
      </SettingsRow>
      <SettingsRow
        title={$i18n.t(isSpace ? 'room.cosmeticsNameSpace' : 'room.cosmeticsName')}
        description={$i18n.t(isSpace ? 'room.cosmeticsNameHintSpace' : 'room.cosmeticsNameHint')}
        wide
      >
        <div class="inline-field">
          <TextInput
            id={`${uid}-name`}
            bind:value={name}
            placeholder={profileName ?? userId ?? ''}
            aria-label={$i18n.t(isSpace ? 'room.cosmeticsNameSpace' : 'room.cosmeticsName')}
          />
          <Button
            variant="secondary"
            disabled={name === savedName || saving === 'name'}
            onclick={saveName}>{$i18n.t('common.save')}</Button
          >
        </div>
      </SettingsRow>
      {#if isSpace}
        <SettingsRow
          title={$i18n.t('room.cosmeticsApplyRooms')}
          description={applyDescription}
          disabled={applyTargets.length === 0 || name !== savedName}
        >
          <Button
            size="small"
            disabled={saving !== null || applyTargets.length === 0 || name !== savedName}
            onclick={applyToRooms}
          >
            {$i18n.t('common.apply')}
          </Button>
        </SettingsRow>
      {/if}
      {#if canSetColor}
        <li class="settings-form form-stack">
          <ColorSetting
            label={$i18n.t('room.cosmeticsColorLight')}
            bind:value={colorOnLight}
            onCommit={() => {
              saveColor('on_light', colorOnLight);
            }}
            onReset={() => {
              colorOnLight = '';
              saveColor('on_light', undefined);
            }}
          />
          <ColorSetting
            label={$i18n.t('room.cosmeticsColorDark')}
            bind:value={colorOnDark}
            onCommit={() => {
              saveColor('on_dark', colorOnDark);
            }}
            onReset={() => {
              colorOnDark = '';
              saveColor('on_dark', undefined);
            }}
          />
        </li>
      {/if}
      <SettingsRow
        title={$i18n.t('room.cosmeticsPronouns')}
        description={canSetPronouns
          ? $i18n.t('room.cosmeticsPronounsHint')
          : $i18n.t('room.cosmeticsNotAllowed')}
        disabled={!canSetPronouns}
        wide
      >
        <div class="inline-field">
          <TextInput
            id={`${uid}-pronouns`}
            bind:value={pronouns}
            disabled={!canSetPronouns}
            placeholder={$i18n.t('room.cosmeticsPronounsPlaceholder')}
            aria-label={$i18n.t('room.cosmeticsPronouns')}
          />
          <Button
            variant="secondary"
            disabled={!canSetPronouns || pronouns === savedPronouns || saving === 'pronouns'}
            onclick={savePronouns}>{$i18n.t('common.save')}</Button
          >
        </div>
      </SettingsRow>
      <SettingsRow
        title={$i18n.t('room.cosmeticsReset')}
        description={$i18n.t('room.cosmeticsResetHint')}
      >
        <Button size="small" disabled={saving !== null} onclick={resetLook}>
          {$i18n.t('common.reset')}
        </Button>
      </SettingsRow>
    </ul>
  </SettingsSection>

  {#if canManage}
    <SettingsSection
      headingId="room-settings-cosmetics-members"
      title={$i18n.t('room.cosmeticsMembersTitle')}
    >
      <ul class="settings-rows">
        <SettingsRow
          title={$i18n.t('room.cosmeticsMembersPronouns')}
          description={$i18n.t(
            isSpace ? 'room.cosmeticsMembersPronounsSpace' : 'room.cosmeticsMembersPronounsRoom'
          )}
        >
          <Switch
            checked={membersSetPronouns}
            disabled={saving !== null}
            label={$i18n.t('room.cosmeticsMembersPronouns')}
            onCheckedChange={(allowed) => {
              allowMembers(COSMETIC_EVENT_TYPES.pronoun, allowed);
            }}
          />
        </SettingsRow>
      </ul>
    </SettingsSection>
  {/if}
</div>

<style>
  .section {
    display: grid;
    gap: var(--space-600);
  }

  .preview {
    background: var(--surface-container);
    border-radius: var(--radius);
    color: var(--surface-on-container);
    margin-bottom: var(--space-300);
    padding: var(--space-300) var(--space-400);
  }

  .avatar-input {
    height: 0;
    opacity: 0;
    position: absolute;
    width: 0;
  }

  .inline-field {
    display: flex;
    gap: var(--space-200);
  }
</style>
