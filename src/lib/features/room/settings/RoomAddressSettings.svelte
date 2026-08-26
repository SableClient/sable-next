<script lang="ts">
  import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { canSendState } from './permission-groups';

  import '#lib/ui/primitives/settings-row.css';

  const CANONICAL_EVENT_TYPE = 'm.room.canonical_alias';

  interface Props {
    room: RoomSummary | null;
    levels: RoomPowerLevelsView | null;
    ownPowerLevel: number;
  }

  let { room, levels, ownPowerLevel }: Props = $props();
  const core = useCoreClient();

  let aliases = $state.raw<string[]>([]);
  let canonical = $state<string | null>(null);
  let alternatives = $state.raw<string[]>([]);
  let draft = $state('');
  let busy = $state(false);
  let outcome = $state<'invalid' | 'failed' | null>(null);
  let run = 0;

  let roomId = $derived(room?.room_id ?? null);
  let canEdit = $derived(canSendState(levels, ownPowerLevel, CANONICAL_EVENT_TYPE));
  let server = $derived(roomId?.split(':').slice(1).join(':') ?? '');

  $effect(() => {
    void roomId;
    void load();
  });

  async function load(): Promise<void> {
    const target = roomId;
    if (!target) return;

    const current = ++run;
    try {
      const [local, canonicalContent] = await Promise.all([
        core.commands.roomAliases(target).catch(() => [] as string[]),
        core.commands.roomStateEvent(target, CANONICAL_EVENT_TYPE),
      ]);
      if (current !== run) return;

      aliases = local;
      const content = canonicalContent as { alias?: unknown; alt_aliases?: unknown } | null;
      canonical = typeof content?.alias === 'string' ? content.alias : null;
      alternatives = Array.isArray(content?.alt_aliases)
        ? content.alt_aliases.filter((entry): entry is string => typeof entry === 'string')
        : [];
    } catch (error) {
      console.debug('[sable room] addresses unavailable', error);
    }
  }

  function normalise(value: string): string | null {
    const trimmed = value.trim().replace(/^#/u, '');
    if (trimmed === '') return null;
    const full = trimmed.includes(':') ? `#${trimmed}` : `#${trimmed}:${server}`;
    return /^#[^:\s]+:\S+$/u.test(full) ? full : null;
  }

  async function add(): Promise<void> {
    const target = roomId;
    const alias = normalise(draft);
    if (!target || busy) return;
    if (alias === null) {
      outcome = 'invalid';
      return;
    }

    busy = true;
    outcome = null;
    try {
      await core.commands.createRoomAlias(target, alias);
      draft = '';
      await load();
    } catch (error) {
      console.warn('[sable room] alias creation failed', error);
      outcome = 'failed';
    } finally {
      busy = false;
    }
  }

  async function remove(alias: string): Promise<void> {
    if (busy) return;

    busy = true;
    outcome = null;
    try {
      if (alias === canonical) await publish(null);
      await core.commands.deleteRoomAlias(alias);
      await load();
    } catch (error) {
      console.warn('[sable room] alias removal failed', error);
      outcome = 'failed';
    } finally {
      busy = false;
    }
  }

  async function publish(alias: string | null): Promise<void> {
    const target = roomId;
    if (!target) return;

    const alt = alternatives.filter((entry) => entry !== alias);
    await core.commands.sendStateEvent(target, CANONICAL_EVENT_TYPE, '', {
      ...(alias === null ? {} : { alias }),
      ...(alt.length > 0 ? { alt_aliases: alt } : {}),
    });
    canonical = alias;
    alternatives = alt;
  }

  async function setMain(alias: string | null): Promise<void> {
    if (busy) return;

    busy = true;
    outcome = null;
    try {
      await publish(alias);
      await load();
    } catch (error) {
      console.warn('[sable room] main address change failed', error);
      outcome = 'failed';
    } finally {
      busy = false;
    }
  }
</script>

<SettingsSection
  headingId="room-settings-addresses"
  title={$i18n.t('room.addressesTitle')}
  description={$i18n.t('room.addressesHint')}
>
  {#if aliases.length > 0}
    <ul class="settings-rows">
      {#each aliases as alias (alias)}
        <li class="settings-row">
          <div class="settings-row-copy">
            <span class="settings-row-name">{alias}</span>
          </div>
          <div class="settings-row-control">
            {#if alias === canonical}
              <StatusBadge variant="primary" label={$i18n.t('room.addressesMain')} />
            {:else if canEdit}
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                onclick={() => {
                  void setMain(alias);
                }}
              >
                {$i18n.t('room.addressesSetMain')}
              </Button>
            {/if}
            {#if canEdit}
              <IconButton
                variant="ghost"
                size="small"
                label={$i18n.t('room.addressesRemove', { alias })}
                disabled={busy}
                onclick={() => {
                  void remove(alias);
                }}
              >
                <TrashIcon />
              </IconButton>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="status">{$i18n.t('room.addressesEmpty')}</p>
  {/if}

  {#if canEdit}
    <div class="settings-form">
      {#if outcome === 'invalid'}
        <Alert variant="critical" role="alert">{$i18n.t('room.addressesInvalid')}</Alert>
      {:else if outcome === 'failed'}
        <Alert variant="critical" role="alert">{$i18n.t('room.addressesFailed')}</Alert>
      {/if}
      <div class="inline">
        <TextInput
          bind:value={draft}
          placeholder={$i18n.t('room.addressesPlaceholder')}
          aria-label={$i18n.t('room.addressesAdd')}
          onkeydown={(event: KeyboardEvent) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void add();
          }}
        />
        <Button
          disabled={draft.trim() === '' || busy}
          onclick={() => {
            void add();
          }}
        >
          {$i18n.t('room.addressesAdd')}
        </Button>
      </div>
    </div>
  {/if}
</SettingsSection>

<style>
  .status {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: var(--space-2) var(--space-3);
  }

  .inline {
    display: grid;
    gap: var(--space-2);
    grid-template-columns: 1fr auto;
  }
</style>
