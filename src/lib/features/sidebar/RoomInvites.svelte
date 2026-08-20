<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { InviteActions } from '#lib/rooms/invites.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';

  interface Props {
    collapsed?: boolean;
  }

  let { collapsed = false }: Props = $props();
  const roomList = useRoomList();
  const answers = new InviteActions(useCoreClient());

  let invites = $derived(roomList.rooms.filter((room) => room.state === 'invited'));

  function initial(name: string): string {
    return name.slice(0, 1).toUpperCase();
  }
</script>

{#if invites.length > 0 && !collapsed}
  <section class="invites" aria-label={$i18n.t('room.invitesTitle')}>
    <h3>{$i18n.t('room.invitesTitle')}</h3>
    <ul>
      {#each invites as invite (invite.room_id)}
        {@const name = invite.name ?? invite.room_id}
        {@const busy = answers.isAnswering(invite.room_id)}
        <li>
          <span class="invite-icon" aria-hidden="true">
            {#if invite.avatar_url}
              <MediaImage
                source={invite.avatar_url}
                alt=""
                width={56}
                height={56}
                class="room-image"
              />
            {:else}
              {initial(name)}
            {/if}
          </span>
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
    padding: 0 0.5rem 0.5rem;
  }

  h3 {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    margin: 0;
    padding: 0 0.5rem;
    text-transform: uppercase;
  }

  ul {
    display: grid;
    gap: 0.25rem;
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0;
  }

  li {
    align-items: center;
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-1);
    min-height: var(--control-height-medium);
    min-width: 0;
    padding: 0 0.25rem 0 0.5rem;
  }

  li:hover {
    background: var(--sable-bg-container-hover);
  }

  .invite-icon {
    align-items: center;
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    display: flex;
    flex: 0 0 1.75rem;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    height: 1.75rem;
    justify-content: center;
    overflow: hidden;
    width: 1.75rem;
  }

  .invite-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
