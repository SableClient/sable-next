<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { RoomPowerLevelsView, RoomSummary, RoomVersionsView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';

  import '#lib/ui/primitives/settings-row.css';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { additionalCreatorsSupported, readCreate, readTombstone } from './room-upgrade';
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
  let creators = $state.raw<string[]>([]);
  let creatorDraft = $state('');
  let creatorInvalid = $state(false);
  let upgrading = $state(false);
  let failed = $state(false);
  let run = 0;

  let roomId = $derived(room?.room_id ?? null);
  let isSpace = $derived(room?.is_space ?? false);
  let canUpgrade = $derived(canSendState(levels, ownPowerLevel, 'm.room.tombstone'));
  let allowCreators = $derived(additionalCreatorsSupported(target));
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

  async function upgrade(): Promise<void> {
    const id = roomId;
    if (!id || target === '' || upgrading) return;

    upgrading = true;
    failed = false;
    try {
      const next = await core.commands.upgradeRoom(id, target, allowCreators ? creators : []);
      open = false;
      onClose();
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
    void goto(roomPath(id));
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
    <Alert variant="warning" role="status">{$i18n.t('room.upgradeIrreversible')}</Alert>

    <FormField fieldId="room-upgrade-version" label={$i18n.t('room.upgradeVersion')}>
      <Select
        id="room-upgrade-version"
        bind:value={target}
        items={versionOptions}
        disabled={upgrading || versionOptions.length === 0}
      />
    </FormField>

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
            {$i18n.t('room.createInviteAdd')}
          </Button>
        </div>
        {#if creatorInvalid}
          <p class="error">{$i18n.t('room.createInviteInvalid')}</p>
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
                  {$i18n.t('room.upgradeCreatorRemove')}
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

    <div class="actions">
      <Button
        variant="ghost"
        disabled={upgrading}
        onclick={() => {
          open = false;
        }}
      >
        {$i18n.t('room.upgradeCancel')}
      </Button>
      <Button
        variant="danger"
        loading={upgrading}
        disabled={target === ''}
        onclick={() => {
          void upgrade();
        }}
      >
        {$i18n.t('room.upgradeAction')}
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
