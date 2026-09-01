<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { InviteActions } from '#lib/rooms/invites.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  interface Props {
    collapsed?: boolean;
  }

  let { collapsed = false }: Props = $props();
  const roomList = useRoomList();
  const answers = new InviteActions(useCoreClient());

  let invites = $derived(roomList.rooms.filter((room) => room.state === 'invited'));
</script>

{#if invites.length > 0 && !collapsed}
  <section class="invites" aria-label={$i18n.t('room.invitesTitle')}>
    <h3>{$i18n.t('room.invitesTitle')}</h3>
    <ul>
      {#each invites as invite (invite.room_id)}
        {@const name = invite.name ?? invite.room_id}
        {@const busy = answers.isAnswering(invite.room_id)}
        <li>
          <Avatar class="invite-icon" src={invite.avatar_url} {name} />
          <span class="invite-name" title={name}>{name}</span>
          <IconButton
            variant="ghost"
            size="small"
            disabled={busy}
            label={$i18n.t('room.inviteAccept')}
            onclick={() => {
              void answers.accept(invite);
            }}
          >
            <CheckIcon />
          </IconButton>
          <IconButton
            variant="ghost"
            size="small"
            disabled={busy}
            label={$i18n.t('room.inviteDecline')}
            onclick={() => {
              void answers.decline(invite);
            }}
          >
            <XIcon />
          </IconButton>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .invites {
    padding: 0 var(--space-200) var(--space-200);
  }

  h3 {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    margin: 0;
    padding: 0 var(--space-200);
    text-transform: uppercase;
  }

  ul {
    display: grid;
    gap: var(--space-100);
    list-style: none;
    margin: var(--space-100) 0 0;
    padding: 0;
  }

  li {
    align-items: center;
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-200);
    min-height: var(--control-height-medium);
    min-width: 0;
    padding: 0 var(--space-100) 0 var(--space-200);
  }

  li:hover {
    background: var(--sable-bg-container-hover);
  }

  :global(.sable-avatar.invite-icon) {
    --avatar-size: 1.75rem;

    font-size: var(--font-size-small);
  }

  :global(.sable-avatar.invite-icon .sable-avatar-fallback) {
    background: var(--sable-surface-var-container);
  }

  .invite-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
