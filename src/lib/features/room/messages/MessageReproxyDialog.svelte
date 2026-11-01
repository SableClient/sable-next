<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon';

  import type { PerMessageProfileView, PersonaView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { filterPersonas } from '#lib/personas/persona.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import ResponsiveDialog from '#lib/ui/primitives/ResponsiveDialog.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { scrollHint } from '#lib/ui/scroll-hint.js';

  interface Props {
    open?: boolean;
    personas: readonly PersonaView[];
    current: PerMessageProfileView | null;
    onChoose: (persona: PersonaView | null) => void;
  }

  let { open = $bindable(false), personas, current, onChoose }: Props = $props();
  let query = $state('');
  let filteredPersonas = $derived(filterPersonas(personas, query));

  function choose(persona: PersonaView | null): void {
    open = false;
    onChoose(persona);
  }
</script>

{#snippet content(desktop: boolean)}
  <h2>{i18n.t('timeline.reproxyMessage')}</h2>
  <TextInput
    bind:value={query}
    class="reproxy-search"
    type="search"
    autocomplete="off"
    placeholder={i18n.t('personas.search')}
    aria-label={i18n.t('personas.search')}
  />
  <ul class={['reproxy-options', { dialog: desktop }]} {@attach scrollHint}>
    <li>
      <button
        type="button"
        class="reproxy-option"
        onclick={() => {
          choose(null);
        }}
      >
        <Avatar size="small"><ProhibitIcon /></Avatar>
        <span class="reproxy-option-name">{i18n.t('personas.pickerOffGlobal')}</span>
        {#if !current}<CheckIcon aria-hidden="true" />{/if}
      </button>
    </li>
    {#each filteredPersonas as persona (persona.id)}
      <li>
        <button
          type="button"
          class="reproxy-option"
          onclick={() => {
            choose(persona);
          }}
        >
          <Avatar
            id={persona.id}
            src={persona.avatar_url}
            name={persona.display_name}
            size="small"
          />
          <span class="reproxy-option-name">{persona.display_name}</span>
          {#if current?.id === persona.id}<CheckIcon aria-hidden="true" />{/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if filteredPersonas.length === 0 && query.trim()}
    <p class="reproxy-empty">{i18n.t('personas.noMatches')}</p>
  {/if}
{/snippet}

<ResponsiveDialog
  bind:open
  label={i18n.t('timeline.reproxyMessage')}
  closeLabel={i18n.t('timeline.closeMenu')}
  children={content}
/>

<style>
  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0 0 var(--space-200);
  }

  :global(.reproxy-search) {
    margin-bottom: var(--space-200);
  }

  .reproxy-options {
    display: grid;
    list-style: none;
    margin: 0;
    max-height: 60vh;
    overflow-y: auto;
    padding: 0;
  }

  .reproxy-options.dialog {
    width: min(22rem, calc(100vw - 2rem));
  }

  .reproxy-option {
    align-items: center;
    background: none;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: var(--space-300);
    min-height: var(--control-height-500);
    padding: var(--space-200) var(--space-300);
    text-align: left;
    width: 100%;
  }

  .reproxy-option:hover,
  .reproxy-option:focus-visible {
    background: var(--surface-container);
  }

  .reproxy-option-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reproxy-empty {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: var(--space-200) var(--space-300);
  }
</style>
