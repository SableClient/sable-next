<script lang="ts">
  import { Popover } from 'bits-ui';
  import UserSwitchIcon from 'phosphor-svelte/lib/UserSwitchIcon';

  import type {
    PerMessageProfileView,
    PersonaView,
    PersonaAlternateAvatarView,
  } from '#src/generated/protocol';

  import { page } from '$app/state';
  import MessageReproxyDialog from '#lib/features/room/messages/MessageReproxyDialog.svelte';
  import { i18n } from '#lib/i18n.js';
  import { resolvePersona, type ProxyMatch } from '#lib/personas/persona.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { AppLayout } from '#lib/ui/app-layout.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import PersonaMenu, { type PersonaScope } from './PersonaMenu.svelte';
  import { personaSpaces } from './persona-spaces.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  interface Props {
    roomId: string;
    onBeforeOpen?: () => void;
    edit?: {
      current: PerMessageProfileView | null;
      onChoose: (persona: PersonaView | null) => void;
    };
    shorthandHint?: ProxyMatch;
  }

  let { roomId, onBeforeOpen, edit, shorthandHint }: Props = $props();
  const personas = usePersonaStore();
  const roomList = useRoomList();
  const appLayout = new AppLayout();

  let desktop = $derived(appLayout.current);
  let open = $state(false);
  let spaces = $derived(personaSpaces(roomList.rooms, roomId, page.params.spaceId));
  let hasSpace = $derived(spaces.target !== null);

  function getScopeToOpen() {
    if (personas.associationFor(roomId) !== undefined) {
      return 'room';
    } else if (hasSpace && spaces?.target && personas.associationFor(spaces.target) !== undefined) {
      return 'space';
    } else {
      return 'account';
    }
  }

  let scope = $state<PersonaScope>(getScopeToOpen());
  let scopeTarget = $derived(scope === 'room' ? roomId : scope === 'space' ? spaces.target : null);
  let selected = $derived(personas.selectionFor(scopeTarget));
  let disabled = $derived(scopeTarget !== null && personas.disabledIn(scopeTarget));
  let active = $derived(
    shorthandHint?.persona ??
      resolvePersona({
        personas: personas.personas,
        room: personas.associationFor(roomId),
        spaces: spaces.order.map((id) => personas.associationFor(id)),
        account: personas.selectionFor(null) ?? undefined,
        now: Date.now(),
      }) ??
      null
  );
  let sortedPersonas = $derived(
    preferences.personaPickerSortOrder === 'recent'
      ? personas.personas.slice().sort((a, b) => (b.last_used ?? 0) - (a.last_used ?? 0))
      : preferences.personaPickerSortOrder === 'alphabetical-asc'
        ? personas.personas.slice().sort((a, b) => a.display_name.localeCompare(b.display_name))
        : preferences.personaPickerSortOrder === 'alphabetical-desc'
          ? personas.personas.slice().sort((a, b) => b.display_name.localeCompare(a.display_name))
          : personas.personas
  );
  let shown = $derived(edit ? edit.current : active);
  let label = $derived(
    shown
      ? i18n.t('personas.sendingAs', { name: shown.display_name })
      : i18n.t('personas.pickerLabel')
  );
  let editOpen = $state(false);
  let activeAvatarUrl = $derived(
    !!active && shorthandHint?.trigger.alternate_avatar_id
      ? active.alternate_avatars?.find(
          (avatar) => avatar.id === shorthandHint.trigger.alternate_avatar_id
        )?.avatar_url
      : !!selected && !!active && selected.alternate_avatar_id
        ? active.alternate_avatars?.find((avatar) => avatar.id === selected.alternate_avatar_id)
            ?.avatar_url
        : active?.avatar_url
  );

  function handleOpenChange(next: boolean): void {
    open = next;
    if (next) {
      scope = getScopeToOpen();
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
      toasts.error(i18n.t('errors.actionFailed'));
    });
  }

  function alternateAvatarChoose(
    avatar: PersonaAlternateAvatarView | null,
    persona: PersonaView
  ): void {
    open = false;
    personas.select(scopeTarget, persona.id, null, avatar?.id).catch((cause: unknown) => {
      console.warn('[sable personas] the selection could not be saved', cause);
      toasts.error(i18n.t('errors.actionFailed'));
    });
  }

  function disable(): void {
    open = false;
    if (scopeTarget === null) return;
    personas.disable(scopeTarget).catch((cause: unknown) => {
      console.warn('[sable personas] the selection could not be saved', cause);
      toasts.error(i18n.t('errors.actionFailed'));
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
                  src={activeAvatarUrl}
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
        sideOffset={10}
        collisionPadding={12}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const searchInput = document.getElementById('persona-search');
          if (searchInput instanceof HTMLInputElement) {
            searchInput.focus();
            searchInput.select();
          }
        }}
      >
        <PersonaMenu
          personas={sortedPersonas}
          {selected}
          {disabled}
          {scope}
          {hasSpace}
          onScope={setScope}
          onChoose={choose}
          onAlternateAvatarChoose={alternateAvatarChoose}
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
        src={activeAvatarUrl}
        name={active?.display_name ?? null}
        size="small"
      />
    {:else}
      <UserSwitchIcon />
    {/if}
  </IconButton>
  <BottomSheet
    bind:open
    label={i18n.t('personas.pickerLabel')}
    closeLabel={i18n.t('common.cancel')}
    onOpenChange={handleOpenChange}
  >
    <PersonaMenu
      personas={sortedPersonas}
      {selected}
      {disabled}
      {scope}
      {hasSpace}
      onScope={setScope}
      onChoose={choose}
      onAlternateAvatarChoose={alternateAvatarChoose}
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
