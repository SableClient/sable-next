<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

  import type { PerMessageProfileView } from '#src/generated/PerMessageProfileView';
  import type { PersonaView } from '#src/generated/PersonaView';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  interface Props {
    open?: boolean;
    personas: readonly PersonaView[];
    current: PerMessageProfileView | null;
    onChoose: (persona: PersonaView | null) => void;
  }

  let { open = $bindable(false), personas, current, onChoose }: Props = $props();

  function choose(persona: PersonaView | null): void {
    open = false;
    onChoose(persona);
  }
</script>

<DialogFrame bind:open variant="sheet" label={$i18n.t('timeline.reproxyTitle')}>
  <h2>{$i18n.t('timeline.reproxyTitle')}</h2>
  <ul class="reproxy-options">
    <li>
      <button
        type="button"
        class="reproxy-option"
        onclick={() => {
          choose(null);
        }}
      >
        <Avatar initials="?" size="small" />
        <span class="reproxy-option-name">{$i18n.t('personas.pickerNone')}</span>
        {#if !current}<CheckIcon aria-hidden="true" />{/if}
      </button>
    </li>
    {#each personas as persona (persona.id)}
      <li>
        <button
          type="button"
          class="reproxy-option"
          onclick={() => {
            choose(persona);
          }}
        >
          <Avatar src={persona.avatar_url} name={persona.display_name} size="small" />
          <span class="reproxy-option-name">{persona.display_name}</span>
          {#if current?.id === persona.id}<CheckIcon aria-hidden="true" />{/if}
        </button>
      </li>
    {/each}
  </ul>
</DialogFrame>

<style>
  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0 0 var(--space-200);
  }

  .reproxy-options {
    display: grid;
    list-style: none;
    margin: 0;
    max-height: 60vh;
    overflow-y: auto;
    padding: 0;
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
    gap: var(--space-2);
    min-height: var(--control-height-500);
    padding: var(--space-1) var(--space-2);
    text-align: left;
    width: 100%;
  }

  .reproxy-option:hover,
  .reproxy-option:focus-visible {
    background: var(--sable-surface-container);
  }

  .reproxy-option-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
