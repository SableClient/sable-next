<script lang="ts" module>
  export type PersonaScope = 'room' | 'space' | 'account';
</script>

<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon';

  import type { PersonaSelectionView, PersonaView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { nameColorOnDark, nameColorOnLight } from '#lib/ui/primitives/readable-color.js';

  import '#lib/features/room/members/sender-identity.css';

  interface Props {
    personas: readonly PersonaView[];
    selected: PersonaSelectionView | null;
    disabled: boolean;
    scope: PersonaScope;
    hasSpace?: boolean;
    onScope: (scope: PersonaScope) => void;
    onChoose: (persona: PersonaView | null) => void;
    onDisable: () => void;
  }

  let {
    personas,
    selected,
    disabled,
    scope,
    hasSpace = false,
    onScope,
    onChoose,
    onDisable,
  }: Props = $props();
  let query = $state('');
  let grid = $derived(!query);
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

  let scopes = $derived(
    (
      [
        { id: 'room', label: 'personas.scopeRoom' },
        { id: 'space', label: 'personas.scopeSpace' },
        { id: 'account', label: 'personas.scopeAccount' },
      ] as const
    ).filter((tab) => hasSpace || tab.id !== 'space')
  );
</script>

{#snippet listItem(persona: PersonaView | null, kind: 'default' | 'disable' | 'offGlobal' | 'off')}
  <li>
    <button
      type="button"
      class="persona-option"
      onclick={() => {
        (kind === 'disable' ? onDisable : onChoose)(persona);
      }}
    >
      {#if persona}
        {@const light = persona.color_on_light ?? persona.color_on_dark}
        {@const dark = persona.color_on_dark ?? persona.color_on_light}
        <Avatar id={persona.id} src={persona.avatar_url} name={persona.display_name} size="small" />
        <span
          class="persona-option-name sender-identity-name"
          class:tinted={light !== null}
          style:--name-color-on-light={nameColorOnLight(light) ?? undefined}
          style:--name-color-on-dark={nameColorOnDark(dark) ?? undefined}
          >{persona.display_name}</span
        >
        {#if selected?.persona_id === persona.id}<CheckIcon />{/if}
      {:else if kind === 'disable'}
        <Avatar size="small"><ProhibitIcon /></Avatar>
        <span class="persona-option-name"
          >{$i18n.t(scope === 'room' ? 'personas.pickerOff' : 'personas.pickerOffSpace')}</span
        >
        {#if disabled}<CheckIcon />{/if}
      {:else if kind === 'offGlobal'}
        <Avatar initials="?" size="small" />
        <span class="persona-option-name">{$i18n.t('personas.pickerOffGlobal')}</span>
        {#if !selected && !disabled}<CheckIcon />{/if}
      {:else}
        <Avatar initials="?" size="small" />
        <span class="persona-option-name">{$i18n.t('personas.pickerNone')}</span>
        {#if !selected && !disabled}<CheckIcon />{/if}
      {/if}
    </button>
  </li>
{/snippet}

{#snippet gridItem(persona: PersonaView | null, kind: 'default' | 'disable' | 'offGlobal' | 'off')}
  <li>
    <button
      type="button"
      class="persona-grid-option"
      class:selected={kind === 'disable'
        ? disabled
        : kind === 'default'
          ? !!persona && selected?.persona_id === persona.id
          : !selected && !disabled}
      onclick={() => {
        console.info(onChoose);
        (kind === 'disable' ? onDisable : onChoose)(persona);
      }}
    >
      {#if persona}
        <Avatar
          id={persona.id}
          src={persona.avatar_url}
          name={persona.display_name}
          size="medium"
        />
      {:else if kind === 'disable'}
        <Avatar size="medium"><ProhibitIcon /></Avatar>
      {:else if kind === 'offGlobal'}
        <Avatar initials="?" size="medium" />
      {:else}
        <Avatar initials="?" size="medium" />
      {/if}
    </button>
  </li>
{/snippet}

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

  <ul class="persona-options" class:grid>
    {#if scope === 'account'}
      {@render (grid ? gridItem : listItem)(null, 'offGlobal')}
    {/if}
    {#if scope === 'room' || scope === 'space'}
      {@render (grid ? gridItem : listItem)(null, 'off')}
    {/if}
    {#if scope === 'room' || scope === 'space'}
      {@render (grid ? gridItem : listItem)(null, 'disable')}
    {/if}
    {#each filteredPersonas as persona, index (`${index}:${persona.id}`)}
      {@render (grid ? gridItem : listItem)(persona, 'default')}
    {/each}
  </ul>

  <TextInput
    class="persona-search"
    bind:value={query}
    type="search"
    autocomplete="off"
    placeholder={$i18n.t('personas.search')}
    aria-label={$i18n.t('personas.search')}
  />
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
    display: flex;
    flex-flow: column nowrap;
    height: 18rem;
    list-style: none;
    margin: 0;
    overflow-y: auto;
    padding: 0;
  }

  .persona-options.grid {
    align-content: flex-end;
    display: flex;
    flex-flow: row wrap;
    gap: var(--space-200);
    padding: var(--space-200);
    padding-block: var(--space-200);

    > * {
      display: flex;
      flex: 1;
      flex-direction: row;
      justify-content: center;
    }
  }

  :global(.persona-search) {
    --form-control-container: var(--surface-container);
    --form-control-container-line: var(--surface-container-line);
    --form-control-color: var(--surface-on-container);

    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    font: inherit;
    margin-inline: 0;
    padding: var(--space-200) var(--space-300);
  }

  .persona-grid-option {
    background: none;
    border: 0;
    border-radius: var(--radius);
    padding: 0;
  }

  .persona-grid-option.selected {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .persona-grid-option:hover,
  .persona-grid-option:focus-visible {
    outline: var(--focus-ring-width) solid var(--surface-container-line);
    outline-offset: var(--focus-ring-offset);
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
    background: var(--surface-var-container);
    color: var(--surface-on-container);
  }

  .persona-option-name {
    flex: 1;
    max-width: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
