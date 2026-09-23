<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon';

  import type { PersonaSelectionView, PersonaView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  interface Props {
    personas: readonly PersonaView[];
    selected: PersonaSelectionView | null;
    disabled: boolean;
    scope: 'room' | 'account';
    onScope: (scope: 'room' | 'account') => void;
    onChoose: (persona: PersonaView | null) => void;
    onDisable: () => void;
  }

  let { personas, selected, disabled, scope, onScope, onChoose, onDisable }: Props = $props();
  let off = $derived(scope === 'room' && disabled);
  let query = $state('');
  let filteredPersonas = $derived(
    personas.filter((persona) => {
      const needle = query.trim().toLocaleLowerCase();
      return (
        needle === '' ||
        persona.display_name.toLocaleLowerCase().includes(needle) ||
        persona.id.toLocaleLowerCase().includes(needle)
      );
    })
  );

  const scopes = [
    { id: 'room', label: 'personas.scopeRoom' },
    { id: 'account', label: 'personas.scopeAccount' },
  ] as const;
</script>

<div class="persona-menu">
  <div class="persona-scopes" role="tablist" aria-label={$i18n.t('personas.pickerHeading')}>
    {#each scopes as tab (tab.id)}
      <button
        type="button"
        role="tab"
        class="persona-scope choice"
        aria-selected={scope === tab.id}
        onclick={() => {
          onScope(tab.id);
        }}
      >
        {$i18n.t(tab.label)}
      </button>
    {/each}
  </div>

  <input
    class="persona-search"
    bind:value={query}
    type="search"
    autocomplete="off"
    placeholder={$i18n.t('search.placeholder')}
    aria-label={$i18n.t('search.title')}
  />

  <ul class="persona-options">
    <li>
      <button
        type="button"
        class="persona-option"
        onclick={() => {
          onChoose(null);
        }}
      >
        <Avatar initials="?" size="small" />
        <span class="persona-option-name">{$i18n.t('personas.pickerNone')}</span>
        {#if !selected && !off}<CheckIcon />{/if}
      </button>
    </li>
    {#if scope === 'room'}
      <li>
        <button type="button" class="persona-option" onclick={onDisable}>
          <Avatar size="small"><ProhibitIcon /></Avatar>
          <span class="persona-option-name">{$i18n.t('personas.pickerOff')}</span>
          {#if off}<CheckIcon />{/if}
        </button>
      </li>
    {/if}
    {#each filteredPersonas as persona (persona.id)}
      <li>
        <button
          type="button"
          class="persona-option"
          onclick={() => {
            onChoose(persona);
          }}
        >
          <Avatar
            id={persona.id}
            src={persona.avatar_url}
            name={persona.display_name}
            size="small"
          />
          <span class="persona-option-name">{persona.display_name}</span>
          {#if selected?.persona_id === persona.id}<CheckIcon />{/if}
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .persona-menu {
    display: grid;
    gap: var(--space-200);
  }

  .persona-scopes {
    display: flex;
    gap: var(--space-200);
    padding: var(--space-200);
  }

  .persona-scope {
    background: none;
    border: var(--border-width) solid transparent;
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    cursor: pointer;
    flex: 1;
    font: inherit;
    padding: var(--space-200);
  }

  .persona-options {
    display: grid;
    list-style: none;
    margin: 0;
    max-height: 18rem;
    overflow-y: auto;
    padding: 0;
  }

  .persona-search {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    color: inherit;
    font: inherit;
    margin-inline: var(--space-200);
    padding: var(--space-200) var(--space-300);
  }

  .persona-option {
    align-items: center;
    background: none;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: var(--space-300);
    padding: var(--space-200) var(--space-300);
    text-align: left;
    width: 100%;
  }

  .persona-option:hover,
  .persona-option:focus-visible {
    background: var(--surface-container);
  }

  .persona-option-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
