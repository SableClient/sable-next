<script lang="ts">
  import type {
    PronounView,
    RoomPermissionsView,
    RoomPowerLevelsView,
    RoomSummary,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import {
    COSMETIC_EVENT_TYPES,
    fontContent,
    pronounContent,
    writeMemberColors,
  } from '#lib/features/composer/slash-commands.js';
  import ColorSetting from '#lib/features/settings/ColorSetting.svelte';
  import { i18n } from '#lib/i18n.js';
  import { COSMETIC_FONTS, cosmeticFont } from '#lib/rooms/cosmetic-fonts.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { senderDisplayColors } from '../members';
  import SenderName from '../SenderName.svelte';
  import { canSendState, toEventContent } from './permission-groups';

  import '#lib/ui/primitives/settings-row.css';

  const DEFAULT_FONT = 'default';
  const MEMBER_LEVEL = 0;
  const MODERATOR_LEVEL = 50;

  interface Props {
    room: RoomSummary | null;
    permissions: RoomPermissionsView | null;
    levels: RoomPowerLevelsView | null;
  }

  let { room, permissions, levels }: Props = $props();
  const core = useCoreClient();
  const pronounsId = $props.id();

  let roomId = $derived(room?.room_id ?? null);
  let userId = $derived(core.session?.user_id ?? null);
  let isSpace = $derived(room?.is_space ?? false);
  let ownLevel = $derived(permissions?.own_power_level ?? 0);
  let currentLevels = $state.raw<RoomPowerLevelsView | null>(null);
  let effectiveLevels = $derived(currentLevels ?? levels);

  let colorOnLight = $state('');
  let colorOnDark = $state('');
  let font = $state(DEFAULT_FONT);
  let pronouns = $state('');
  let savedPronouns = $state('');
  let saving = $state<string | null>(null);
  let failed = $state(false);
  let run = 0;

  let canSetColor = $derived(canSendState(effectiveLevels, ownLevel, 'm.room.member'));
  let canSetFont = $derived(canSendState(effectiveLevels, ownLevel, COSMETIC_EVENT_TYPES.font));
  let canSetPronouns = $derived(
    canSendState(effectiveLevels, ownLevel, COSMETIC_EVENT_TYPES.pronoun)
  );
  let canManage = $derived(permissions?.can_change_power_levels ?? false);
  let membersSetFonts = $derived(
    effectiveLevels?.events[COSMETIC_EVENT_TYPES.font] === MEMBER_LEVEL
  );
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
      font: cosmeticFont(font)?.family ?? null,
      pronouns: previewPronouns,
    })
  );
  let fontItems = $derived([
    { value: DEFAULT_FONT, label: $i18n.t('room.cosmeticsFontDefault') },
    ...COSMETIC_FONTS.map((entry) => ({ value: entry.name, label: entry.name })),
  ]);

  $effect(() => {
    const target = roomId;
    const self = userId;
    if (!target || !self) return;
    void load(target, self);
  });

  function record(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  }

  function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  async function load(target: string, self: string): Promise<void> {
    const current = ++run;
    try {
      const [member, fontEvent, pronounEvent] = await Promise.all([
        core.commands.roomStateEvent(target, 'm.room.member', self),
        core.commands.roomStateEvent(target, COSMETIC_EVENT_TYPES.font, self),
        core.commands.roomStateEvent(target, COSMETIC_EVENT_TYPES.pronoun, self),
      ]);
      if (current !== run) return;
      const colors = record(record(member)['eu.she-a.color']);
      colorOnLight = text(colors.on_light);
      colorOnDark = text(colors.on_dark);
      font = cosmeticFont(text(record(fontEvent).font))?.name ?? DEFAULT_FONT;
      const sets = record(pronounEvent).pronouns;
      pronouns = Array.isArray(sets)
        ? sets
            .map((set) => text(record(set).summary))
            .filter((summary) => summary !== '')
            .join(', ')
        : '';
      savedPronouns = pronouns;
    } catch (error) {
      console.warn('[sable room] cosmetics unavailable', error);
    }
  }

  async function save(key: string, write: (target: string, self: string) => Promise<void>) {
    const target = roomId;
    const self = userId;
    if (!target || !self || saving !== null) return;
    saving = key;
    failed = false;
    try {
      await write(target, self);
    } catch (error) {
      console.warn('[sable room] cosmetic not saved', error);
      failed = true;
    } finally {
      saving = null;
    }
  }

  function saveColor(theme: 'on_light' | 'on_dark', value: string | undefined): void {
    void save(theme, (target, self) =>
      writeMemberColors(core.commands, target, self, {
        kind: 'set',
        colors: { [theme]: value },
      })
    );
  }

  function saveFont(next: string): void {
    font = next;
    void save('font', (target, self) =>
      core.commands.sendStateEvent(
        target,
        COSMETIC_EVENT_TYPES.font,
        self,
        fontContent(next === DEFAULT_FONT ? 'reset' : next) ?? {}
      )
    );
  }

  function savePronouns(): void {
    void save('pronouns', async (target, self) => {
      await core.commands.sendStateEvent(
        target,
        COSMETIC_EVENT_TYPES.pronoun,
        self,
        pronounContent(pronouns.trim() === '' ? 'reset' : pronouns) ?? {}
      );
      savedPronouns = pronouns;
    });
  }

  function allowMembers(eventType: string, allowed: boolean): void {
    const base = effectiveLevels;
    if (!base) return;
    const next = {
      ...base,
      events: { ...base.events, [eventType]: allowed ? MEMBER_LEVEL : MODERATOR_LEVEL },
    };
    void save(eventType, async (target) => {
      await core.commands.sendStateEvent(target, 'm.room.power_levels', '', toEventContent(next));
      currentLevels = next;
    });
  }
</script>

<div class="section">
  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.cosmeticsFailed')}</Alert>
  {/if}

  <SettingsSection
    headingId="room-settings-cosmetics"
    title={$i18n.t(isSpace ? 'room.cosmeticsTitleSpace' : 'room.cosmeticsTitleRoom')}
    description={$i18n.t(isSpace ? 'room.cosmeticsHintSpace' : 'room.cosmeticsHintRoom')}
  >
    <div class="preview" aria-hidden="true">
      <SenderName
        displayName={core.session?.user_id ?? ''}
        colors={previewColors}
        font={cosmeticFont(font)?.family ?? null}
        pronouns={{ visible: previewPronouns, overflow: [] }}
      />
    </div>
    <ul class="settings-rows">
      <SettingsRow title={$i18n.t('room.cosmeticsColorLight')} disabled={!canSetColor} wide>
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
      </SettingsRow>
      <SettingsRow title={$i18n.t('room.cosmeticsColorDark')} disabled={!canSetColor} wide>
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
      </SettingsRow>
      <SettingsRow
        title={$i18n.t('room.cosmeticsFont')}
        description={canSetFont ? undefined : $i18n.t('room.cosmeticsNotAllowed')}
        disabled={!canSetFont}
      >
        <Select
          value={font}
          aria-label={$i18n.t('room.cosmeticsFont')}
          items={fontItems}
          disabled={!canSetFont || saving === 'font'}
          onValueChange={saveFont}
        />
      </SettingsRow>
      <SettingsRow
        title={$i18n.t('room.cosmeticsPronouns')}
        description={canSetPronouns
          ? $i18n.t('room.cosmeticsPronounsHint')
          : $i18n.t('room.cosmeticsNotAllowed')}
        disabled={!canSetPronouns}
        wide
      >
        <div class="pronouns">
          <TextInput
            id={pronounsId}
            bind:value={pronouns}
            disabled={!canSetPronouns}
            placeholder={$i18n.t('room.cosmeticsPronounsPlaceholder')}
            aria-label={$i18n.t('room.cosmeticsPronouns')}
          />
          <Button
            variant="secondary"
            disabled={!canSetPronouns || pronouns === savedPronouns || saving === 'pronouns'}
            onclick={savePronouns}>{$i18n.t('room.cosmeticsSave')}</Button
          >
        </div>
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
        <SettingsRow
          title={$i18n.t('room.cosmeticsMembersFonts')}
          description={$i18n.t(
            isSpace ? 'room.cosmeticsMembersFontsSpace' : 'room.cosmeticsMembersFontsRoom'
          )}
        >
          <Switch
            checked={membersSetFonts}
            disabled={saving !== null}
            label={$i18n.t('room.cosmeticsMembersFonts')}
            onCheckedChange={(allowed) => {
              allowMembers(COSMETIC_EVENT_TYPES.font, allowed);
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
    margin-bottom: var(--space-300);
    padding: var(--space-300) var(--space-400);
  }

  .pronouns {
    display: flex;
    gap: var(--space-200);
  }
</style>
