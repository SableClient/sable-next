<script lang="ts">
  import { goto } from '$app/navigation';
  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
  import { resolve } from '$app/paths';
  import type { RoomPowerLevelsView, RoomSummary, RoomVersionsView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import OptionCards from '#lib/ui/primitives/OptionCards.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';

  import '#lib/ui/primitives/settings-row.css';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import {
    additionalCreatorsSupported,
    readCreate,
    readReplacementId,
    readTombstone,
  } from './room-upgrade';
  import { canSendState } from './permission-groups';

  interface Props {
    room: RoomSummary | null;
    levels: RoomPowerLevelsView | null;
    ownPowerLevel: number;
    onClose: () => void;
  }

  let { room, levels, ownPowerLevel, onClose }: Props = $props();
  const core = useCoreClient();
  const userIdPattern = /^@[^:\s]+:\S+$/;

  let version = $state<string | null>(null);
  let predecessor = $state<string | null>(null);
  let replacement = $state<string | null>(null);
  let tombstoneBody = $state<string | null>(null);
  let versions = $state.raw<RoomVersionsView | null>(null);

  let open = $state(false);
  let target = $state('');
  let mode = $state<'server' | 'custom' | 'redirect'>('server');
  let encrypted = $state(true);
  let replacementDraft = $state('');
  let messageDraft = $state('');
  let creators = $state.raw<string[]>([]);
  let creatorDraft = $state('');
  let creatorInvalid = $state(false);
  let upgrading = $state(false);
  let failed = $state(false);
  let run = 0;

  let roomId = $derived(room?.room_id ?? null);
  let isSpace = $derived(room?.is_space ?? false);
  let canUpgrade = $derived(canSendState(levels, ownPowerLevel, 'm.room.tombstone'));
  let allowCreators = $derived(mode === 'server' && additionalCreatorsSupported(target));
  let replacementId = $derived.by(() => {
    const parsed = readReplacementId(replacementDraft);
    return parsed === roomId ? null : parsed;
  });
  let replacementInvalid = $derived(replacementDraft.trim() !== '' && replacementId === null);
  let encryptable = $derived(room?.join_rule !== 'public');
  let defaultBody = $derived(
    isSpace ? $i18n.t('room.upgradeReplacedSpace') : $i18n.t('room.upgradeReplacedRoom')
  );
  let modeOptions = $derived([
    {
      value: 'server' as const,
      label: $i18n.t('room.upgradeModeServer'),
      hint: $i18n.t('room.upgradeModeServerHint'),
    },
    {
      value: 'custom' as const,
      label: $i18n.t('room.upgradeModeCustom'),
      hint: $i18n.t('room.upgradeModeCustomHint'),
    },
    {
      value: 'redirect' as const,
      label: $i18n.t('room.upgradeModeRedirect'),
      hint: $i18n.t('room.upgradeModeRedirectHint'),
    },
  ]);
  let actionLabel = $derived(
    mode === 'redirect'
      ? $i18n.t('room.upgradeActionRedirect')
      : mode === 'custom'
        ? $i18n.t('room.upgradeActionReplace')
        : $i18n.t('room.upgradeAction')
  );
  let canSubmit = $derived(mode === 'redirect' ? replacementId !== null : target !== '');
  let versionOptions = $derived(
    (versions?.available ?? []).map((entry) => ({
      value: entry.id,
      label: entry.stable
        ? entry.id
        : $i18n.t('room.upgradeVersionUnstable', { version: entry.id }),
    }))
  );

  $effect(() => {
    const id = roomId;
    if (!id) return;

    const current = ++run;
    void Promise.all([
      core.commands.roomStateEvent(id, 'm.room.create'),
      core.commands.roomStateEvent(id, 'm.room.tombstone'),
    ])
      .then(([create, tombstone]) => {
        if (current !== run) return;
        const parsed = readCreate(create);
        version = parsed.version;
        predecessor = parsed.predecessor;

        const grave = readTombstone(tombstone);
        replacement = grave.replacement;
        tombstoneBody = grave.body;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] room create unreadable', error);
      });
  });

  async function openDialog(): Promise<void> {
    creators = [];
    creatorDraft = '';
    creatorInvalid = false;
    mode = 'server';
    encrypted = room?.encrypted ?? true;
    replacementDraft = '';
    messageDraft = '';
    failed = false;
    open = true;

    if (versions === null) {
      try {
        versions = await core.commands.roomVersions();
      } catch (error) {
        console.warn('[sable room] room versions unavailable', error);
        failed = true;
        return;
      }
    }
    target = versions.default;
  }

  function addCreator(): void {
    const candidate = creatorDraft.trim();
    if (candidate === '') return;
    if (!userIdPattern.test(candidate)) {
      creatorInvalid = true;
      return;
    }
    creatorInvalid = false;
    if (!creators.includes(candidate)) creators = [...creators, candidate];
    creatorDraft = '';
  }

  async function replaceWithNewRoom(id: string): Promise<string> {
    const kind = isSpace ? 'space' : room?.is_voice ? 'voice' : 'text';
    const next = await core.commands.createRoom({
      name: room?.name,
      topic: room?.topic,
      kind,
      public: room?.join_rule === 'public',
      encrypted,
      roomVersion: target,
      predecessor: id,
    });
    await core.commands.sendStateEvent(id, 'm.room.tombstone', '', {
      body: messageDraft.trim() || defaultBody,
      replacement_room: next,
    });
    return next;
  }

  async function upgrade(): Promise<void> {
    const id = roomId;
    if (!id || !canSubmit || upgrading) return;

    upgrading = true;
    failed = false;
    try {
      let next: string;
      if (mode === 'redirect') {
        next = replacementId ?? '';
        await core.commands.sendStateEvent(id, 'm.room.tombstone', '', {
          body: messageDraft.trim() || defaultBody,
          replacement_room: next,
        });
      } else if (mode === 'custom') {
        next = await replaceWithNewRoom(id);
      } else {
        next = await core.commands.upgradeRoom(id, target, allowCreators ? creators : []);
      }
      open = false;
      onClose();
      await afterOverlayPops();
      await goto(roomPath(next));
    } catch (error) {
      console.warn('[sable room] upgrade failed', error);
      failed = true;
    } finally {
      upgrading = false;
    }
  }

  function roomPath(id: string): string {
    const param = roomPathParamFromId(id);
    return isSpace
      ? resolve('/(app)/space/[spaceId]', { spaceId: param })
      : resolve('/(app)/rooms/[roomId]', { roomId: param });
  }

  function openRoom(id: string): void {
    onClose();
    void afterOverlayPops().then(() => goto(roomPath(id)));
  }
</script>

<SettingsSection headingId="room-settings-upgrade" title={$i18n.t('room.settingsAdvanced')}>
  <ul class="settings-rows">
    <SettingsRow
      title={isSpace ? $i18n.t('room.upgradeSpaceTitle') : $i18n.t('room.upgradeRoomTitle')}
      description={replacement
        ? (tombstoneBody ??
          (isSpace ? $i18n.t('room.upgradeReplacedSpace') : $i18n.t('room.upgradeReplacedRoom')))
        : $i18n.t('room.upgradeCurrentVersion', { version: version ?? '?' })}
    >
      {#if predecessor}
        {@const old = predecessor}
        <Button
          size="small"
          variant="secondary"
          onclick={() => {
            openRoom(old);
          }}
        >
          {isSpace ? $i18n.t('room.upgradeOldSpace') : $i18n.t('room.upgradeOldRoom')}
        </Button>
      {/if}
      {#if replacement}
        {@const next = replacement}
        <Button
          size="small"
          onclick={() => {
            openRoom(next);
          }}
        >
          {isSpace ? $i18n.t('room.upgradeOpenSpace') : $i18n.t('room.upgradeOpenRoom')}
        </Button>
      {:else}
        <Button
          size="small"
          disabled={!canUpgrade}
          onclick={() => {
            void openDialog();
          }}
        >
          {$i18n.t('room.upgradeAction')}
        </Button>
      {/if}
    </SettingsRow>
  </ul>
</SettingsSection>

<DialogFrame
  {open}
  onOpenChange={(next: boolean) => {
    open = next;
  }}
  variant="verification"
  label={isSpace ? $i18n.t('room.upgradeSpaceTitle') : $i18n.t('room.upgradeRoomTitle')}
>
  <div class="upgrade">
    <h2>{isSpace ? $i18n.t('room.upgradeSpaceTitle') : $i18n.t('room.upgradeRoomTitle')}</h2>
    <OptionCards
      label={$i18n.t('room.upgradeMode')}
      value={mode}
      disabled={upgrading}
      options={modeOptions}
      onSelect={(next) => {
        mode = next;
        failed = false;
      }}
    />

    {#if mode === 'redirect'}
      <FormField fieldId="room-upgrade-replacement" label={$i18n.t('room.upgradeReplacement')}>
        <p class="hint">{$i18n.t('room.upgradeReplacementHint')}</p>
        <TextInput
          id="room-upgrade-replacement"
          bind:value={replacementDraft}
          placeholder="!room:example.org"
          disabled={upgrading}
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
        />
        {#if replacementInvalid}
          <p class="error">{$i18n.t('room.upgradeReplacementInvalid')}</p>
        {/if}
      </FormField>
    {:else}
      <FormField fieldId="room-upgrade-version" label={$i18n.t('room.upgradeVersion')}>
        <Select
          id="room-upgrade-version"
          bind:value={target}
          items={versionOptions}
          disabled={upgrading || versionOptions.length === 0}
        />
      </FormField>
    {/if}

    {#if mode === 'custom'}
      <div class="toggle-row">
        <div>
          <p class="toggle-label">{$i18n.t('common.endtoendEncryption')}</p>
          <p class="hint">
            {!encryptable
              ? $i18n.t('room.createEncryptionUnavailable')
              : encrypted
                ? $i18n.t('room.createEncryptionHint')
                : $i18n.t('room.upgradeEncryptionOff')}
          </p>
        </div>
        <Switch
          checked={encryptable && encrypted}
          disabled={upgrading || !encryptable}
          label={$i18n.t('common.endtoendEncryption')}
          onCheckedChange={(next: boolean) => {
            encrypted = next;
          }}
        />
      </div>
    {/if}

    {#if mode !== 'server'}
      <FormField fieldId="room-upgrade-message" label={$i18n.t('room.upgradeMessage')}>
        <TextInput
          id="room-upgrade-message"
          bind:value={messageDraft}
          placeholder={defaultBody}
          disabled={upgrading}
        />
      </FormField>
    {/if}

    {#if allowCreators}
      <FormField fieldId="room-upgrade-creator" label={$i18n.t('room.upgradeCreators')}>
        <p class="hint">{$i18n.t('room.upgradeCreatorsHint')}</p>
        <div class="creator-row">
          <TextInput
            id="room-upgrade-creator"
            bind:value={creatorDraft}
            placeholder={$i18n.t('room.createInvitePlaceholder')}
            disabled={upgrading}
            onkeydown={(event: KeyboardEvent) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              addCreator();
            }}
          />
          <Button variant="secondary" disabled={upgrading} onclick={addCreator}>
            {$i18n.t('common.add')}
          </Button>
        </div>
        {#if creatorInvalid}
          <p class="error">{$i18n.t('common.aUserIdLooksLikeSomeoneserver')}</p>
        {/if}
        {#if creators.length > 0}
          <ul class="creators">
            {#each creators as creator (creator)}
              <li>
                <span>{creator}</span>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={upgrading}
                  onclick={() => {
                    creators = creators.filter((entry) => entry !== creator);
                  }}
                >
                  {$i18n.t('common.remove')}
                </Button>
              </li>
            {/each}
          </ul>
        {/if}
      </FormField>
    {/if}

    {#if failed}
      <Alert variant="critical" role="alert">{$i18n.t('room.upgradeFailed')}</Alert>
    {/if}

    <Alert variant="warning" role="status">
      {mode === 'server'
        ? $i18n.t('room.upgradeIrreversible')
        : $i18n.t('room.upgradeIrreversibleManual')}
    </Alert>

    <div class="actions">
      <Button
        variant="ghost"
        disabled={upgrading}
        onclick={() => {
          open = false;
        }}
      >
        {$i18n.t('common.cancel')}
      </Button>
      <Button
        variant="danger"
        loading={upgrading}
        disabled={!canSubmit}
        onclick={() => {
          void upgrade();
        }}
      >
        {actionLabel}
      </Button>
    </div>
  </div>
</DialogFrame>

<style>
  .upgrade {
    display: grid;
    gap: var(--space-400);
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .toggle-row {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
  }

  .toggle-label {
    margin: 0;
  }

  .creator-row {
    display: grid;
    gap: var(--space-300);
    grid-template-columns: 1fr auto;
  }

  .creators {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .creators li {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
  }

  .error {
    color: var(--crit-main);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-300);
    justify-content: flex-end;
  }
</style>
