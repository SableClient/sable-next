<script lang="ts">
  import { Popover } from 'bits-ui';
  import UserSwitchIcon from 'phosphor-svelte/lib/UserSwitchIcon';

  import type {
    PerMessageProfileView,
    PersonaView,
    PersonaAlternateAvatarView,
  } from '#src/generated/protocol';

  import { page } from '$app/state';
  import { useCoreClient } from '#lib/core/context.js';
  import MessageReproxyDialog from '#lib/features/room/messages/MessageReproxyDialog.svelte';
  import { i18n } from '#lib/i18n.js';
  import {
    alternateAvatarId,
    heldSelection,
    resolvePersona,
    type ProxyMatch,
    type SelectionScope,
  } from '#lib/personas/persona.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { UserProfile } from '#lib/profile/user-profile.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { AppLayout } from '#lib/ui/app-layout.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import { collisionPadding } from '#lib/ui/titlebar-inset.svelte.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import PersonaMenu from './PersonaMenu.svelte';
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
  const core = useCoreClient();
  const ownProfile = new UserProfile(core, () => core.session?.user_id);
  let account = $derived.by(() => {
    const id = core.session?.user_id;
    if (!id) return null;
    const profile = ownProfile.current;
    return { id, name: profile?.display_name ?? id, avatarUrl: profile?.avatar_url ?? null };
  });
  const roomList = useRoomList();
  const appLayout = new AppLayout();

  let desktop = $derived(appLayout.current);
  let open = $state(false);
  let spaces = $derived(personaSpaces(roomList.rooms, roomId, page.params.spaceId));
  let hasSpace = $derived(spaces.target !== null);

  let scopeChoice = $derived(preferences.personaSelectionScope === 'picker');

  let scope = $state<SelectionScope>('account');
  let scopeSelections = $derived({
    personas: personas.personas,
    room: personas.associationFor(roomId),
    spaces: spaces.order.map((id) => personas.associationFor(id)),
    account: personas.selectionFor(null) ?? undefined,
    now: Date.now(),
  });
  let held = $derived(heldSelection(scopeSelections));
  let selected = $derived(held && held !== 'account' ? held : null);
  let active = $derived(shorthandHint?.persona ?? resolvePersona(scopeSelections) ?? null);
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
      : account
        ? i18n.t('personas.sendingAs', { name: account.name })
        : i18n.t('personas.pickerLabel')
  );
  let editOpen = $state(false);
  let activeAvatarId = $derived(active && alternateAvatarId(active, shorthandHint?.trigger, held));
  let activeAvatarUrl = $derived(
    active?.alternate_avatars?.find((avatar) => avatar.id === activeAvatarId)?.avatar_url ??
      active?.avatar_url
  );

  function handleOpenChange(next: boolean): void {
    open = next;
    if (next) {
      scope = personas.scopeFor(preferences.personaSelectionScope, roomId, spaces);
      void personas.load();
    }
  }

  function openSheet(): void {
    onBeforeOpen?.();
    handleOpenChange(true);
  }

  function setScope(next: SelectionScope): void {
    scope = next;
  }

  function remember(personaId: string | null, alternateAvatarId: string | null = null): void {
    open = false;
    personas
      .remember(scope, roomId, spaces, personaId, alternateAvatarId)
      .catch((cause: unknown) => {
        console.warn('[sable personas] the selection could not be saved', cause);
        toasts.error(i18n.t('errors.actionFailed'));
      });
  }

  function choose(persona: PersonaView | null): void {
    remember(persona?.id ?? null);
  }

  function alternateAvatarChoose(
    avatar: PersonaAlternateAvatarView | null,
    persona: PersonaView
  ): void {
    remember(persona.id, avatar?.id ?? null);
  }
</script>

{#snippet buttonContent(
  persona: PerMessageProfileView | PersonaView | null,
  personaAvatarOverride: string | null | undefined
)}
  {#if persona}
    <Avatar
      id={persona.id ?? null}
      src={personaAvatarOverride ?? persona.avatar_url ?? null}
      name={persona.display_name ?? null}
      size="small"
    />
  {:else if !preferences.personaPickerShowAccountWhenDeselected}
    <UserSwitchIcon />
  {:else}
    <Avatar
      id={account?.id ?? null}
      src={account?.avatarUrl}
      name={account?.name ?? null}
      size="small"
    />
  {/if}
{/snippet}

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
    {@render buttonContent(shown, null)}
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
              {@render buttonContent(active, activeAvatarUrl)}
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
        collisionPadding={collisionPadding(12)}
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
          {scope}
          {scopeChoice}
          {hasSpace}
          variant="popover"
          onScope={setScope}
          onChoose={choose}
          onAlternateAvatarChoose={alternateAvatarChoose}
          {account}
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
    {@render buttonContent(active, activeAvatarUrl)}
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
      {scope}
      {scopeChoice}
      {hasSpace}
      variant="sheet"
      onScope={setScope}
      onChoose={choose}
      onAlternateAvatarChoose={alternateAvatarChoose}
      {account}
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
    width: min(19rem, calc(100vw - 2rem));
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
