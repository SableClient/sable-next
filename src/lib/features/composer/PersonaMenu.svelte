<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

  import type { PersonaSelectionView } from '#src/generated/PersonaSelectionView';
  import type { PersonaView } from '#src/generated/PersonaView';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  interface Props {
    personas: readonly PersonaView[];
    selected: PersonaSelectionView | null;
    scope: 'room' | 'account';
    onScope: (scope: 'room' | 'account') => void;
    onChoose: (persona: PersonaView | null) => void;
  }

  let { personas, selected, scope, onScope, onChoose }: Props = $props();

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
        class="persona-scope"
        aria-selected={scope === tab.id}
        onclick={() => {
          onScope(tab.id);
        }}
      >
        {$i18n.t(tab.label)}
      </button>
    {/each}
  </div>

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
        {#if !selected}<CheckIcon />{/if}
      </button>
    </li>
    {#each personas as persona (persona.id)}
      <li>
        <button
          type="button"
          class="persona-option"
          onclick={() => {
            onChoose(persona);
          }}
        >
          <Avatar
            src={persona.avatar_url}
            initials={persona.display_name.slice(0, 1)}
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
    gap: var(--space-1);
  }

  .persona-scopes {
    display: flex;
    gap: var(--space-1);
    padding: var(--space-1);
  }

  .persona-scope {
    background: none;
    border: 0;
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    flex: 1;
    font: inherit;
    padding: var(--space-1);
  }

  .persona-scope[aria-selected='true'] {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  .persona-options {
    display: grid;
    list-style: none;
    margin: 0;
    max-height: 18rem;
    overflow-y: auto;
    padding: 0;
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
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    text-align: left;
    width: 100%;
  }

  .persona-option:hover,
  .persona-option:focus-visible {
    background: var(--sable-surface-container);
  }

  .persona-option-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
