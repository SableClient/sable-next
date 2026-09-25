<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

  import type { PerMessageProfileView, PersonaView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  interface Props {
    open?: boolean;
    personas: readonly PersonaView[];
    current: PerMessageProfileView | null;
    onChoose: (persona: PersonaView | null) => void;
  }

  let { open = $bindable(false), personas, current, onChoose }: Props = $props();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let desktop = $derived(appLayout.matches);

  function choose(persona: PersonaView | null): void {
    open = false;
    onChoose(persona);
  }
</script>

{#snippet content()}
  <h2>{$i18n.t('timeline.reproxyTitle')}</h2>
  <ul class="reproxy-options" class:dialog={desktop}>
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
{/snippet}

{#if desktop}
  <DialogFrame bind:open variant="verification" label={$i18n.t('timeline.reproxyTitle')}>
    {@render content()}
  </DialogFrame>
{:else}
  <BottomSheet
    bind:open
    label={$i18n.t('timeline.reproxyTitle')}
    closeLabel={$i18n.t('timeline.closeMenu')}
  >
    {@render content()}
  </BottomSheet>
{/if}

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
</style>
