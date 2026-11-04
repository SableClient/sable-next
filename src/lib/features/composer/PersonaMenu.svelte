<script lang="ts">
  import { scrollHint } from '#lib/ui/scroll-hint.js';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon';
  import ListIcon from 'phosphor-svelte/lib/ListBulletsIcon';
  import GridIcon from 'phosphor-svelte/lib/SquaresFourIcon';
  import RoomIcon from 'phosphor-svelte/lib/HashStraightIcon';
  import SpaceIcon from 'phosphor-svelte/lib/HouseIcon';
  import GlobalIcon from 'phosphor-svelte/lib/GlobeSimpleIcon';
  import ImageSquareIcon from 'phosphor-svelte/lib/ImageSquareIcon';

  import type {
    PersonaSelectionView,
    PersonaView,
    PersonaAlternateAvatarView,
  } from '#src/generated/protocol';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';

  import { i18n } from '#lib/i18n.js';
  import { filterPersonas, type SelectionScope } from '#lib/personas/persona.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { nameColorOnDark, nameColorOnLight } from '#lib/ui/primitives/readable-color.js';

  import '#lib/features/room/members/sender-identity.css';

  interface Props {
    personas: readonly PersonaView[];
    selected: PersonaSelectionView | null;
    scope: SelectionScope;
    scopeChoice?: boolean;
    hasSpace?: boolean;
    variant?: 'popover' | 'sheet';
    onScope: (scope: SelectionScope) => void;
    onChoose: (persona: PersonaView | null) => void;
    onAlternateAvatarChoose: (
      alternateAvatar: PersonaAlternateAvatarView | null,
      persona: PersonaView
    ) => void;
    account?: { id: string; name: string; avatarUrl: string | null } | null;
  }

  let {
    personas,
    selected,
    scope,
    scopeChoice = false,
    hasSpace = false,
    variant,
    onScope,
    onChoose,
    onAlternateAvatarChoose,
    account = null,
  }: Props = $props();
  let accountLabel = $derived(
    account
      ? i18n.t('personas.pickerAccount', { name: account.name })
      : i18n.t('personas.pickerOffGlobal')
  );
  let query = $state('');
  let grid = $derived(preferences.personaGrid && !query);
  let alternateAvatarAvailable = $derived(
    selected !== null &&
      (personas.find((persona) => persona.id === selected.persona_id)?.alternate_avatars ?? [])
        .length > 0
  );
  let alternateAvatarMode = $derived(
    preferences.personaAlternateAvatar && alternateAvatarAvailable
  );
  let prefilteredPersonas = $derived(
    personas.filter((persona) => persona.id == selected?.persona_id || !persona.sort_flags?.hidden)
  );
  let filteredPersonas = $derived(
    filterPersonas(query == '' ? prefilteredPersonas : personas, query)
  );

  const SCOPES = {
    room: { label: 'personas.rememberedRoom', icon: RoomIcon },
    space: { label: 'personas.rememberedSpace', icon: SpaceIcon },
    account: { label: 'personas.rememberedAccount', icon: GlobalIcon },
  } as const;
  let scopeOrder = $derived<SelectionScope[]>(
    hasSpace ? ['room', 'space', 'account'] : ['room', 'account']
  );
  let scopeLabel = $derived(i18n.t(SCOPES[scope].label));
  let ScopeIcon = $derived(SCOPES[scope].icon);

  function cycleScope(): void {
    onScope(scopeOrder[(scopeOrder.indexOf(scope) + 1) % scopeOrder.length]);
  }
</script>

{#snippet listItem(persona: PersonaView | null)}
  <li>
    <button
      type="button"
      class="persona-option"
      onclick={() => {
        onChoose(persona);
      }}
    >
      {#if persona}
        {@const light = persona.color_on_light ?? persona.color_on_dark}
        {@const dark = persona.color_on_dark ?? persona.color_on_light}
        <Avatar id={persona.id} src={persona.avatar_url} name={persona.display_name} size="small" />
        <span
          class={['persona-option-name sender-identity-name', { tinted: light !== null }]}
          style:--name-color-on-light={nameColorOnLight(light) ?? undefined}
          style:--name-color-on-dark={nameColorOnDark(dark) ?? undefined}
          >{persona.display_name}</span
        >
        {#if selected?.persona_id === persona.id}<CheckIcon />{/if}
      {:else}
        {#if account}
          <Avatar id={account.id} src={account.avatarUrl} name={account.name} size="small" />
        {:else}
          <Avatar size="small"><ProhibitIcon /></Avatar>
        {/if}
        <span class="persona-option-name">{accountLabel}</span>
        {#if !selected}<CheckIcon />{/if}
      {/if}
    </button>
  </li>
{/snippet}

{#snippet gridItem(persona: PersonaView | null)}
  {@const label = persona ? persona.display_name : accountLabel}

  <li>
    <button
      type="button"
      class={[
        'persona-grid-option',
        { selected: persona ? selected?.persona_id === persona.id : !selected },
      ]}
      onclick={() => {
        onChoose(persona);
      }}
      aria-label={label}
    >
      <Tooltip {label} side="bottom">
        {#snippet trigger({ props: tip })}
          <div {...tip}>
            {#if persona}
              <Avatar
                id={persona.id}
                src={persona.avatar_url}
                name={persona.display_name}
                size="medium"
              />
            {:else if account}
              <Avatar id={account.id} src={account.avatarUrl} name={account.name} size="medium" />
            {:else}
              <Avatar id={null} size="medium" name={label}><ProhibitIcon /></Avatar>
            {/if}
          </div>
        {/snippet}
      </Tooltip>
    </button>
  </li>
{/snippet}

{#snippet alternateAvatarItem(
  item:
    | { kind: 'alternate'; view: PersonaAlternateAvatarView; persona: PersonaView }
    | { kind: 'main'; view: PersonaView }
)}
  {@const label =
    item.kind === 'alternate'
      ? 'personas.alternateAvatarLabel'
      : (item.view.display_name ?? item.view.id)}

  <li>
    <button
      type="button"
      class={[
        'persona-grid-option',
        {
          selected:
            selected !== null &&
            (item.kind === 'alternate'
              ? selected.alternate_avatar_id === item.view.id
              : selected.alternate_avatar_id === null),
        },
      ]}
      onclick={() => {
        item.kind === 'alternate'
          ? onAlternateAvatarChoose(item.view, item.persona)
          : onAlternateAvatarChoose(null, item.view);
      }}
      aria-label={label}
    >
      <Tooltip {label} side="bottom">
        {#snippet trigger({ props: tip })}
          <div {...tip}>
            <Avatar
              id={item.view.id}
              src={item.view.avatar_url}
              name={item.kind === 'alternate' ? item.view.id : item.view.display_name}
              size="medium"
            />
          </div>
        {/snippet}
      </Tooltip>
    </button>
  </li>
{/snippet}

<div class={['persona-menu', { sheet: variant === 'sheet' }]}>
  {#if alternateAvatarMode && !!selected}
    {@const current = personas.find((persona) => persona.id === selected.persona_id)}
    {#if current}
      <ul class="persona-options grid" {@attach scrollHint}>
        {@render alternateAvatarItem({ kind: 'main', view: current })}
        {#each current.alternate_avatars as avatar (avatar.id)}
          {@render alternateAvatarItem({ kind: 'alternate', view: avatar, persona: current })}
        {/each}
      </ul>
    {/if}
  {:else}
    <ul class={['persona-options', { grid }]} {@attach scrollHint}>
      {@render (grid ? gridItem : listItem)(null)}
      {#each filteredPersonas as persona, index (`${index}:${persona.id}`)}
        {@render (grid ? gridItem : listItem)(persona)}
      {/each}
    </ul>
  {/if}

  <div class="persona-toolbar" class:alternate-avatar={alternateAvatarMode}>
    {#if !alternateAvatarMode}
      {#if scopeChoice}
        <Tooltip label={scopeLabel}>
          {#snippet trigger({ props })}
            <IconButton {...props} size="small" label={scopeLabel} onclick={cycleScope}>
              <ScopeIcon />
            </IconButton>
          {/snippet}
        </Tooltip>
      {/if}
      <TextInput
        id="persona-search"
        bind:value={query}
        type="search"
        autocomplete="off"
        placeholder={i18n.t('personas.search')}
        aria-label={i18n.t('personas.search')}
        onkeyup={(event) => {
          if (event.key === 'Enter' && query && filteredPersonas && filteredPersonas.length !== 0) {
            onChoose(filteredPersonas[0]);
          }
        }}
      />

      {#if !query}
        <Tooltip label={grid ? i18n.t('personas.listView') : i18n.t('personas.gridView')}>
          {#snippet trigger({ props })}
            <IconButton
              {...props}
              size="small"
              label={grid ? i18n.t('personas.listView') : i18n.t('personas.gridView')}
              onclick={() => {
                setPreference('personaGrid', !preferences.personaGrid);
              }}
            >
              {#if preferences.personaGrid}<ListIcon />{:else}<GridIcon />{/if}
            </IconButton>
          {/snippet}
        </Tooltip>
      {/if}
    {/if}
    {#if alternateAvatarAvailable}
      <Tooltip
        label={alternateAvatarMode
          ? i18n.t('personas.alternateAvatarViewOff')
          : i18n.t('personas.alternateAvatarViewOn')}
      >
        {#snippet trigger({ props })}
          <IconButton
            {...props}
            size="small"
            variant={!preferences.personaAlternateAvatar && !!selected?.alternate_avatar_id
              ? 'primary'
              : 'secondary'}
            label={alternateAvatarMode ? i18n.t('personas.listView') : i18n.t('personas.gridView')}
            onclick={() => {
              setPreference('personaAlternateAvatar', !preferences.personaAlternateAvatar);
            }}
          >
            {#if preferences.personaAlternateAvatar}<GridIcon />{:else}<ImageSquareIcon />{/if}
          </IconButton>
        {/snippet}
      </Tooltip>
    {/if}
  </div>
</div>

<style>
  .persona-menu {
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    height: min(24rem, 60dvh);
  }

  .persona-menu.sheet {
    padding: var(--space-050);
  }

  .persona-toolbar {
    display: flex;
    gap: var(--space-200);
  }

  .persona-menu.sheet .persona-toolbar {
    padding: 0 var(--space-250);
  }

  .persona-toolbar :global(> button) {
    flex: 0 0 auto;

    --button-height: var(--control-height-400);
  }

  .persona-toolbar.alternate-avatar {
    justify-content: end;
  }

  .persona-options {
    display: flex;
    flex-flow: column nowrap;
    flex-grow: 1;
    height: fit-content;
    list-style: none;
    margin: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 0;
  }

  .persona-options.grid {
    align-content: flex-start;
    display: flex;
    flex-flow: row wrap-reverse;
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

  :global(#persona-search) {
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
