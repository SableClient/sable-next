<script lang="ts">
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import type { PersonaView } from '#src/generated/PersonaView';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import {
    fetchPluralkitMembers,
    matchImported,
    personaFromPluralkit,
    systemIdFromInput,
    type PluralkitMember,
  } from '#lib/personas/pluralkit.js';
  import { triggerLabel } from '#lib/personas/persona.js';
  import { formatPronouns } from '#lib/personas/pronouns.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import PersonaEditor from './PersonaEditor.svelte';

  const core = useCoreClient();
  const personas = usePersonaStore();

  let editorOpen = $state(false);
  let editing = $state<PersonaView | null>(null);
  let removing = $state<string | null>(null);
  let error = $state<string | null>(null);

  let systemInput = $state('');
  let token = $state('');
  let importing = $state(false);
  let importNotice = $state<string | null>(null);

  $effect(() => {
    void personas.load();
  });

  function openEditor(persona: PersonaView | null): void {
    editing = persona;
    editorOpen = true;
  }

  async function save(persona: PersonaView, previousId: string | null): Promise<void> {
    await personas.save(persona, previousId);
    error = null;
  }

  async function remove(persona: PersonaView): Promise<void> {
    if (!confirm($i18n.t('personas.removeConfirm'))) return;
    removing = persona.id;
    error = null;
    try {
      await personas.remove(persona.id);
    } catch (cause) {
      console.warn('[sable personas] deleting failed', cause);
      error = $i18n.t('personas.removeFailed');
    } finally {
      removing = null;
    }
  }

  async function avatarFor(member: PluralkitMember, existing: PersonaView | undefined) {
    if (!member.avatar_url) return { url: existing?.avatar_url ?? null, failed: false };
    if (existing?.pluralkit?.avatar_url === member.avatar_url && existing.avatar_url) {
      return { url: existing.avatar_url, failed: false };
    }

    try {
      const response = await fetch(member.avatar_url);
      if (!response.ok) throw new Error(`avatar responded ${String(response.status)}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mime = response.headers.get('content-type') ?? 'image/*';
      return { url: await core.uploadMedia(mime, bytes), failed: false };
    } catch (cause) {
      console.warn('[sable personas] fetching a PluralKit picture failed', cause);
      return { url: existing?.avatar_url ?? null, failed: true };
    }
  }

  async function runImport(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const systemId = systemIdFromInput(systemInput);
    if (systemId === '') return;

    importing = true;
    error = null;
    importNotice = null;
    try {
      const members = await fetchPluralkitMembers(systemId, token.trim() || null);
      let pictures = 0;

      for (const member of members) {
        const existing = matchImported(personas.personas, member);
        const avatar = await avatarFor(member, existing);
        if (avatar.failed) pictures += 1;
        await personas.save(personaFromPluralkit(member, avatar.url), existing?.id ?? null);
      }

      importNotice =
        pictures === 0
          ? $i18n.t('personas.importDone', { count: members.length })
          : $i18n.t('personas.importAvatarFailed', { count: pictures });
      token = '';
    } catch (cause) {
      console.warn('[sable personas] the PluralKit import failed', cause);
      error = $i18n.t('personas.importFailed');
    } finally {
      importing = false;
    }
  }
</script>

<div class="persona-stack">
  {#if error}<Alert variant="critical" aria-live="polite">{error}</Alert>{/if}
  {#if personas.error}<Alert variant="critical">{$i18n.t(personas.error)}</Alert>{/if}

  <SettingsSection
    title={$i18n.t('personas.manageTitle')}
    description={$i18n.t('personas.manageDescription')}
    headingId="settings-personas"
  >
    {#if personas.loading && personas.personas.length === 0}
      <p class="persona-empty"><Spinner small /></p>
    {:else if personas.personas.length === 0}
      <p class="persona-empty">{$i18n.t('personas.empty')}</p>
    {:else}
      <ul class="persona-list">
        {#each personas.personas as persona (persona.id)}
          <li>
            <Avatar
              src={persona.avatar_url}
              initials={persona.display_name.slice(0, 1)}
              size="small"
            />
            <div class="persona-copy">
              <span class="persona-name">{persona.display_name}</span>
              {#if persona.pronouns.length > 0}
                <span class="persona-meta">{formatPronouns(persona.pronouns)}</span>
              {/if}
              {#if persona.triggers.length > 0}
                <span class="persona-meta">
                  {persona.triggers.map(triggerLabel).join(' · ')}
                </span>
              {/if}
            </div>
            <IconButton
              variant="ghost"
              size="small"
              label={$i18n.t('personas.edit', { name: persona.display_name })}
              onclick={() => {
                openEditor(persona);
              }}
            >
              <PencilSimpleIcon />
            </IconButton>
            <IconButton
              variant="ghost"
              size="small"
              disabled={removing === persona.id}
              label={$i18n.t('personas.remove', { name: persona.display_name })}
              onclick={() => void remove(persona)}
            >
              <TrashIcon />
            </IconButton>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="persona-actions">
      <Button
        variant="secondary"
        size="small"
        onclick={() => {
          openEditor(null);
        }}
      >
        <PlusIcon />
        {$i18n.t('personas.add')}
      </Button>
    </div>
  </SettingsSection>

  <SettingsSection
    title={$i18n.t('personas.importTitle')}
    description={$i18n.t('personas.importDescription')}
    headingId="settings-personas-pluralkit"
  >
    <form class="import-form" onsubmit={(event) => void runImport(event)}>
      {#if importNotice}<Alert variant="info" aria-live="polite">{importNotice}</Alert>{/if}
      <label class="field">
        <span>{$i18n.t('personas.importSystem')}</span>
        <TextInput
          bind:value={systemInput}
          required
          placeholder={$i18n.t('personas.importSystemPlaceholder')}
        />
      </label>
      <label class="field">
        <span>{$i18n.t('personas.importToken')}</span>
        <TextInput bind:value={token} type="password" autocomplete="off" />
        <small>{$i18n.t('personas.importTokenHint')}</small>
      </label>
      <div class="persona-actions">
        <Button type="submit" size="small" loading={importing}>
          {$i18n.t('personas.importAction')}
        </Button>
      </div>
    </form>
  </SettingsSection>
</div>

<PersonaEditor
  bind:open={editorOpen}
  persona={editing}
  onSave={save}
  onOpenChange={(next: boolean) => {
    editorOpen = next;
    if (!next) editing = null;
  }}
/>

<style>
  .persona-stack {
    display: grid;
    gap: var(--space-3);
  }

  .persona-list {
    display: grid;
    gap: var(--space-1);
    list-style: none;
    margin: 0;
    padding: var(--space-2);
  }

  .persona-list li {
    align-items: center;
    display: flex;
    gap: var(--space-2);
  }

  .persona-copy {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .persona-name {
    font-weight: var(--font-weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .persona-meta {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .persona-empty {
    color: var(--sable-surface-var-on-container);
    margin: 0;
    padding: var(--space-3);
  }

  .persona-actions {
    display: flex;
    justify-content: flex-end;
    padding: 0 var(--space-3) var(--space-3);
  }

  .import-form {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-3) 0;
  }

  .field {
    display: grid;
    gap: var(--space-1);
  }

  .field span {
    font-weight: var(--font-weight-medium);
  }

  .field small {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }
</style>
