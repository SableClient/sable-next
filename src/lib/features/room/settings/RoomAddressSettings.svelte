<script lang="ts">
  import type { RoomPowerLevelsView, RoomSummary } from '#src/generated/protocol';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
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
  let selected = $state.raw<ReadonlySet<string>>(new Set());
  let pendingRemoval = $state.raw<readonly string[]>([]);
  let outcome = $state<'invalid' | 'failed' | null>(null);
  let run = 0;

  let roomId = $derived(room?.room_id ?? null);
  let canEdit = $derived(canSendState(levels, ownPowerLevel, CANONICAL_EVENT_TYPE));
  let server = $derived(core.session?.user_id.split(':').slice(1).join(':') ?? '');
  let published = $derived([
    ...(canonical === null ? [] : [canonical]),
    ...alternatives.filter((alias) => alias !== canonical),
  ]);
  let chosen = $derived(aliases.filter((alias) => selected.has(alias)));
  let allSelected = $derived(aliases.length > 0 && chosen.length === aliases.length);

  $effect(() => {
    void roomId;
    selected = new Set();
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
      selected = new Set([...selected].filter((alias) => local.includes(alias)));
      const content = canonicalContent as { alias?: unknown; alt_aliases?: unknown } | null;
      canonical = typeof content?.alias === 'string' ? content.alias : null;
      alternatives = Array.isArray(content?.alt_aliases)
        ? [
            ...new Set(
              content.alt_aliases.filter((entry): entry is string => typeof entry === 'string')
            ),
          ]
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

  async function change(action: () => Promise<void>, label: string): Promise<void> {
    if (busy) return;

    busy = true;
    outcome = null;
    try {
      await action();
      await load();
    } catch (error) {
      console.warn(`[sable room] ${label} failed`, error);
      outcome = 'failed';
    } finally {
      busy = false;
    }
  }

  async function writeCanonical(alias: string | null, alt: readonly string[]): Promise<void> {
    const target = roomId;
    if (!target) return;

    const rest = [...new Set(alt)].filter((entry) => entry !== alias);
    await core.commands.sendStateEvent(target, CANONICAL_EVENT_TYPE, '', {
      ...(alias === null ? {} : { alias }),
      ...(rest.length > 0 ? { alt_aliases: rest } : {}),
    });
    canonical = alias;
    alternatives = rest;
  }

  function add(): void {
    const target = roomId;
    const alias = normalise(draft);
    if (!target || busy) return;
    if (alias === null) {
      outcome = 'invalid';
      return;
    }

    void change(async () => {
      await core.commands.createRoomAlias(target, alias);
      draft = '';
    }, 'alias creation');
  }

  function setMain(alias: string): void {
    void change(() => writeCanonical(alias, alternatives), 'main address change');
  }

  function unsetMain(): void {
    void change(() => writeCanonical(null, alternatives), 'main address change');
  }

  function unpublish(targets: readonly string[]): void {
    void change(
      () =>
        writeCanonical(
          canonical !== null && targets.includes(canonical) ? null : canonical,
          alternatives.filter((alias) => !targets.includes(alias))
        ),
      'unpublish'
    );
  }

  function publish(targets: readonly string[]): void {
    void change(() => writeCanonical(canonical, [...alternatives, ...targets]), 'publish');
  }

  async function confirmRemoval(): Promise<void> {
    const targets = pendingRemoval;
    if (targets.length === 0) return;
    await change(async () => {
      if (targets.some((alias) => published.includes(alias))) {
        await writeCanonical(
          canonical !== null && targets.includes(canonical) ? null : canonical,
          alternatives.filter((alias) => !targets.includes(alias))
        );
      }
      for (const alias of targets) await core.commands.deleteRoomAlias(alias);
      selected = new Set();
    }, 'alias removal');
    pendingRemoval = [];
  }

  function toggle(alias: string): void {
    selected = selected.has(alias)
      ? new Set([...selected].filter((entry) => entry !== alias))
      : new Set([...selected, alias]);
  }

  function toggleAll(): void {
    selected = allSelected ? new Set() : new Set(aliases);
  }
</script>

<SettingsSection
  headingId="room-settings-published-addresses"
  title={$i18n.t('room.addressesPublishedTitle')}
  description={$i18n.t('room.addressesPublishedHint')}
>
  {#if published.length > 0}
    <ul class="settings-rows">
      {#each published as alias (alias)}
        <SettingsRow title={alias}>
          {#if alias === canonical}
            <StatusBadge variant="primary" label={$i18n.t('room.addressesMain')} />
            {#if canEdit}
              <Button size="small" variant="ghost" disabled={busy} onclick={unsetMain}>
                {$i18n.t('room.addressesUnsetMain')}
              </Button>
            {/if}
          {:else if canEdit}
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onclick={() => {
                setMain(alias);
              }}
            >
              {$i18n.t('room.addressesSetMain')}
            </Button>
          {/if}
          {#if canEdit}
            <IconButton
              variant="subtle"
              size="small"
              label={$i18n.t('room.addressesUnpublish', { alias })}
              disabled={busy}
              onclick={() => {
                unpublish([alias]);
              }}
            >
              <XIcon />
            </IconButton>
          {/if}
        </SettingsRow>
      {/each}
    </ul>
  {:else}
    <p class="settings-note settings-form">{$i18n.t('room.addressesPublishedEmpty')}</p>
  {/if}
</SettingsSection>

<SettingsSection
  headingId="room-settings-addresses"
  title={$i18n.t('room.addressesTitle')}
  description={$i18n.t('room.addressesHint')}
>
  {#if canEdit && aliases.length > 0}
    <div class="bulk-bar">
      <label class="bulk-select-all">
        <input type="checkbox" checked={allSelected} disabled={busy} onchange={toggleAll} />
        {$i18n.t('room.addressesSelectAll')}
      </label>
      {#if chosen.length > 0}
        <span class="bulk-count">
          {$i18n.t('room.addressesSelectedCount', { count: chosen.length })}
        </span>
        <div class="bulk-actions">
          <Button
            size="small"
            variant="secondary"
            disabled={busy || chosen.every((alias) => published.includes(alias))}
            onclick={() => {
              publish(chosen);
            }}
          >
            {$i18n.t('room.addressesPublish')}
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={busy || !chosen.some((alias) => published.includes(alias))}
            onclick={() => {
              unpublish(chosen);
            }}
          >
            {$i18n.t('room.addressesUnpublishSelected')}
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={busy}
            onclick={() => {
              pendingRemoval = chosen;
            }}
          >
            {$i18n.t('room.addressesDeleteSelected')}
          </Button>
        </div>
      {/if}
    </div>
  {/if}

  {#if aliases.length > 0}
    <ul class="settings-rows">
      {#each aliases as alias (alias)}
        <SettingsRow title={alias}>
          {#snippet before()}
            {#if canEdit}
              <label class="alias-select">
                <input
                  type="checkbox"
                  checked={selected.has(alias)}
                  disabled={busy}
                  aria-label={$i18n.t('room.addressesSelect', { alias })}
                  onchange={() => {
                    toggle(alias);
                  }}
                />
              </label>
            {/if}
          {/snippet}
          {#if alias === canonical}
            <StatusBadge variant="primary" label={$i18n.t('room.addressesMain')} />
          {:else if published.includes(alias)}
            <StatusBadge label={$i18n.t('room.addressesPublished')} />
          {/if}
          {#if canEdit}
            <IconButton
              variant="subtle"
              size="small"
              label={$i18n.t('room.addressesRemove', { alias })}
              disabled={busy}
              onclick={() => {
                pendingRemoval = [alias];
              }}
            >
              <TrashIcon />
            </IconButton>
          {/if}
        </SettingsRow>
      {/each}
    </ul>
  {:else}
    <p class="settings-note settings-form">{$i18n.t('room.addressesEmpty')}</p>
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
            add();
          }}
        />
        <Button disabled={draft.trim() === '' || busy} onclick={add}>
          {$i18n.t('room.addressesAdd')}
        </Button>
      </div>
    </div>
  {/if}
</SettingsSection>

<ConfirmDialog
  open={pendingRemoval.length > 0}
  onOpenChange={(next: boolean) => {
    if (!next && busy === false) pendingRemoval = [];
  }}
  title={pendingRemoval.length === 1
    ? $i18n.t('room.addressesRemoveConfirm', { alias: pendingRemoval[0] })
    : $i18n.t('room.addressesRemoveManyConfirm', { count: pendingRemoval.length })}
  confirmLabel={$i18n.t('room.remove')}
  {busy}
  onConfirm={() => void confirmRemoval()}
/>

<style>
  .bulk-bar {
    align-items: center;
    border-bottom: var(--border-width) solid var(--surface-var-container-line);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
    padding: var(--space-300) var(--space-400);
  }

  .bulk-select-all {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .bulk-count {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .bulk-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
    margin-inline-start: auto;
  }

  .alias-select {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    inline-size: var(--icon-size-small);
    justify-content: center;
    position: relative;
  }

  .alias-select::after {
    content: '';
    inset: calc((var(--icon-size-small) - var(--target-hit)) / 2);
    position: absolute;
  }

  .alias-select input,
  .bulk-select-all input {
    accent-color: var(--primary-main);
    block-size: var(--icon-size-small);
    inline-size: var(--icon-size-small);
    margin: 0;
  }

  .inline {
    display: grid;
    gap: var(--space-300);
    grid-template-columns: 1fr auto;
  }
</style>
