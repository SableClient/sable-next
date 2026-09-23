<script lang="ts">
  import { Popover } from 'bits-ui';
  import UserSwitchIcon from 'phosphor-svelte/lib/UserSwitchIcon';

  import type { PersonaView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';

  import PersonaMenu from './PersonaMenu.svelte';

  interface Props {
    roomId: string;
    onBeforeOpen?: () => void;
  }

  let { roomId, onBeforeOpen }: Props = $props();
  const personas = usePersonaStore();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);

  let desktop = $derived(appLayout.matches);
  let open = $state(false);
  let scope = $state<'room' | 'account'>('account');

  let selected = $derived(personas.selectionFor(scope === 'room' ? roomId : null));
  let disabled = $derived(personas.disabledIn(roomId));
  let active = $derived(
    disabled
      ? null
      : (personas.personas.find(
          (persona) => persona.id === personas.selectionFor(roomId)?.persona_id
        ) ??
          personas.personas.find(
            (persona) => persona.id === personas.selectionFor(null)?.persona_id
          ) ??
          null)
  );
  let label = $derived(
    active
      ? $i18n.t('personas.sendingAs', { name: active.display_name })
      : $i18n.t('personas.pickerLabel')
  );

  function handleOpenChange(next: boolean): void {
    open = next;
    if (next) {
      scope = 'account';
      void personas.load();
    }
  }

  function openSheet(): void {
    onBeforeOpen?.();
    handleOpenChange(true);
  }

  function setScope(next: 'room' | 'account'): void {
    scope = next;
  }

  function choose(persona: PersonaView | null): void {
    open = false;
    personas
      .select(scope === 'room' ? roomId : null, persona?.id ?? null)
      .catch((cause: unknown) => {
        console.warn('[sable personas] the selection could not be saved', cause);
      });
  }

  function disable(): void {
    open = false;
    personas.disable(roomId).catch((cause: unknown) => {
      console.warn('[sable personas] the selection could not be saved', cause);
    });
  }
</script>

{#if desktop}
  <Popover.Root {open} onOpenChange={handleOpenChange}>
    <Popover.Trigger>
      {#snippet child({ props })}
        <IconButton
          {...props}
          variant="ghost"
          size="small"
          class="persona-button-format selection-open"
          {label}
        >
          {#if active}
            <Avatar
              id={active.id}
              src={active.avatar_url}
              name={active.display_name}
              size="small"
            />
          {:else}
            <UserSwitchIcon />
          {/if}
        </IconButton>
      {/snippet}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        class="persona-picker-popover"
        {...overlayLayer()}
        side="top"
        align="start"
        collisionPadding={12}
      >
        <PersonaMenu
          personas={personas.personas}
          {selected}
          {disabled}
          {scope}
          onScope={setScope}
          onChoose={choose}
          onDisable={disable}
        />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{:else}
  <IconButton
    variant="ghost"
    size="small"
    class="persona-button-format selection-open"
    {label}
    aria-haspopup="dialog"
    aria-expanded={open}
    data-state={open ? 'open' : 'closed'}
    onclick={openSheet}
  >
    {#if active}
      <Avatar id={active.id} src={active.avatar_url} name={active.display_name} size="small" />
    {:else}
      <UserSwitchIcon />
    {/if}
  </IconButton>
  <BottomSheet
    bind:open
    label={$i18n.t('personas.pickerHeading')}
    closeLabel={$i18n.t('personas.cancel')}
    onOpenChange={handleOpenChange}
  >
    <PersonaMenu
      personas={personas.personas}
      {selected}
      {disabled}
      {scope}
      onScope={setScope}
      onChoose={choose}
      onDisable={disable}
    />
  </BottomSheet>
{/if}

<style>
  :global(.persona-picker-popover) {
    background: var(--bg-container);
    border-radius: var(--radius);
    box-shadow: var(--shadow-dialog);
    padding: var(--space-200);
    width: min(18rem, calc(100vw - 2rem));
  }

  :global(.persona-button-format) {
    color: var(--surface-var-on-container);
  }
</style>
