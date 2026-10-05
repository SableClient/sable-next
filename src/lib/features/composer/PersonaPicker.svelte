<script lang="ts">
  import { Popover } from 'bits-ui';
  import UserSwitchIcon from 'phosphor-svelte/lib/UserSwitchIcon';

  import type { PerMessageProfileView, PersonaView } from '#src/generated/protocol';

  import { page } from '$app/state';
  import MessageReproxyDialog from '#lib/features/room/messages/MessageReproxyDialog.svelte';
  import { i18n } from '#lib/i18n.js';
  import { resolvePersona } from '#lib/personas/persona.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import PersonaMenu, { type PersonaScope } from './PersonaMenu.svelte';
  import { personaSpaces } from './persona-spaces.js';

  interface Props {
    roomId: string;
    onBeforeOpen?: () => void;
    edit?: {
      current: PerMessageProfileView | null;
      onChoose: (persona: PersonaView | null) => void;
    };
  }

  let { roomId, onBeforeOpen, edit }: Props = $props();
  const personas = usePersonaStore();
  const roomList = useRoomList();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);

  let desktop = $derived(appLayout.matches);
  let open = $state(false);
  let scope = $state<PersonaScope>('account');

  let spaces = $derived(personaSpaces(roomList.rooms, roomId, page.params.spaceId));
  let scopeTarget = $derived(scope === 'room' ? roomId : scope === 'space' ? spaces.target : null);
  let selected = $derived(personas.selectionFor(scopeTarget));
  let disabled = $derived(scopeTarget !== null && personas.disabledIn(scopeTarget));
  let active = $derived(
    resolvePersona({
      personas: personas.personas,
      room: personas.associationFor(roomId),
      spaces: spaces.order.map((id) => personas.associationFor(id)),
      account: personas.selectionFor(null) ?? undefined,
      now: Date.now(),
    }) ?? null
  );
  let shown = $derived(edit ? edit.current : active);
  let label = $derived(
    shown
      ? $i18n.t('personas.sendingAs', { name: shown.display_name })
      : $i18n.t('personas.pickerLabel')
  );
  let editOpen = $state(false);

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

  function setScope(next: PersonaScope): void {
    scope = next;
  }

  function choose(persona: PersonaView | null): void {
    open = false;
    personas.select(scopeTarget, persona?.id ?? null).catch((cause: unknown) => {
      console.warn('[sable personas] the selection could not be saved', cause);
      toasts.error($i18n.t('errors.actionFailed'));
    });
  }

  function disable(): void {
    open = false;
    if (scopeTarget === null) return;
    personas.disable(scopeTarget).catch((cause: unknown) => {
      console.warn('[sable personas] the selection could not be saved', cause);
      toasts.error($i18n.t('errors.actionFailed'));
    });
  }
</script>

{#if edit}
  <IconButton
    variant="ghost"
    size="small"
    class="persona-button-format selection-open"
    {label}
    aria-haspopup="dialog"
    aria-expanded={editOpen}
    data-state={editOpen ? 'open' : 'closed'}
    onclick={() => {
      onBeforeOpen?.();
      editOpen = true;
    }}
  >
    {#if shown}
      <Avatar id={shown.id} src={shown.avatar_url ?? null} name={shown.display_name} size="small" />
    {:else}
      <UserSwitchIcon />
    {/if}
  </IconButton>
  <MessageReproxyDialog
    bind:open={editOpen}
    personas={personas.personas}
    current={edit.current}
    onChoose={edit.onChoose}
  />
{:else if desktop}
  <Popover.Root {open} onOpenChange={handleOpenChange}>
    <Tooltip {label}>
      {#snippet trigger({ props: tip })}
        <Popover.Trigger {...tip}>
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
                  id={active?.id ?? null}
                  src={active?.avatar_url ?? null}
                  name={active?.display_name ?? null}
                  size="small"
                />
              {:else}
                <UserSwitchIcon />
              {/if}
            </IconButton>
          {/snippet}
        </Popover.Trigger>
      {/snippet}
    </Tooltip>
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
          hasSpace={spaces.target !== null}
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
      <Avatar
        id={active?.id ?? null}
        src={active?.avatar_url ?? null}
        name={active?.display_name ?? null}
        size="small"
      />
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
      hasSpace={spaces.target !== null}
      onScope={setScope}
      onChoose={choose}
      onDisable={disable}
    />
  </BottomSheet>
{/if}

<style>
  :global(.persona-picker-popover) {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    color: var(--surface-on-container);
    padding: var(--space-200);
    width: min(18rem, calc(100vw - 2rem));
  }

  :global(.persona-button-format) {
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    flex: 0 0 auto;
    height: var(--target);
    min-height: var(--target);
    position: relative;
    width: var(--target);
  }

  :global(.persona-button-format)::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  :global(.persona-button-format .avatar-root) {
    --avatar-size: var(--avatar-size-200);
  }
</style>
