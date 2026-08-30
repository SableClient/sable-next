<script lang="ts">
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import LockSimpleIcon from 'phosphor-svelte/lib/LockSimpleIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { formatDate } from '#lib/features/room/timeline-format.js';
  import { i18n } from '#lib/i18n.js';
  import { InviteActions } from '#lib/rooms/invites.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import { inviter, pendingInvites, senderName } from './inbox';

  const roomList = useRoomList();
  const answers = new InviteActions(useCoreClient());
  const headingId = $props.id();

  let invites = $derived(pendingInvites(roomList.rooms));

  function roomName(room: RoomSummary): string {
    return room.name ?? room.canonical_alias ?? room.room_id;
  }
</script>

{#if invites.length > 0}
  <section aria-labelledby={headingId}>
    <h2 id={headingId}>
      {$i18n.t('inbox.invites')}
      <span class="count">{invites.length}</span>
    </h2>
    <ul>
      {#each invites as invite (invite.room_id)}
        {@const name = roomName(invite)}
        {@const from = inviter(invite)}
        {@const busy = answers.isAnswering(invite.room_id)}
        <li class="card">
          <div class="head">
            <Avatar src={invite.avatar_url} {name} size="large" />
            <div class="identity">
              <p class="name">
                <span class="name-text">{name}</span>
                {#if invite.encrypted}
                  <span class="lock" title={$i18n.t('inbox.inviteEncrypted')}>
                    <LockSimpleIcon aria-hidden="true" />
                  </span>
                {/if}
              </p>
              <p class="meta">
                {#if invite.is_space}
                  <StatusBadge label={$i18n.t('inbox.inviteSpace')} variant="secondary" />
                {/if}
                {#if from}
                  <span title={from}>{$i18n.t('inbox.invitedBy', { name: senderName(from) })}</span>
                {/if}
                {#if invite.latest_event?.timestamp}
                  <span>{formatDate(invite.latest_event.timestamp)}</span>
                {/if}
                {#if invite.canonical_alias}
                  <span class="alias">{invite.canonical_alias}</span>
                {/if}
              </p>
            </div>
          </div>

          {#if invite.topic}
            <p class="topic">{invite.topic}</p>
          {/if}

          <div class="actions">
            <Button
              variant="ghost"
              disabled={busy}
              onclick={() => {
                void answers.decline(invite);
              }}>{$i18n.t('room.inviteDecline')}</Button
            >
            <Button
              disabled={busy}
              onclick={() => {
                void answers.accept(invite);
              }}>{$i18n.t('room.inviteAccept')}</Button
            >
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  h2 {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    gap: var(--space-200);
    letter-spacing: 0.08em;
    margin: 0 0 var(--space-300);
    text-transform: uppercase;
  }

  .count {
    background: var(--sable-primary-main);
    border-radius: var(--radius-pill);
    color: var(--sable-primary-on-main);
    font-variant-numeric: tabular-nums;
    letter-spacing: normal;
    min-width: 1.25rem;
    padding: 0 var(--space-100);
    text-align: center;
  }

  ul {
    display: grid;
    gap: var(--space-300);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .card {
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-400);
    padding: var(--space-400);
  }

  .head {
    align-items: center;
    display: flex;
    gap: var(--space-400);
  }

  .identity {
    display: grid;
    flex: 1;
    gap: var(--space-100);
    min-width: 0;
  }

  .identity p {
    margin: 0;
    min-width: 0;
  }

  .name {
    align-items: center;
    display: flex;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-medium);
    gap: var(--space-100);
    line-height: var(--line-height-heading);
  }

  .name-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lock {
    color: var(--sable-success-main);
    display: flex;
    flex: 0 0 auto;
  }

  .lock :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .meta {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    overflow: hidden;
  }

  .meta > span + span::before {
    content: '·';
    padding-right: var(--space-200);
  }

  .alias {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .topic {
    -webkit-box-orient: vertical;
    color: var(--sable-surface-var-on-container);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    line-height: var(--line-height-body);
    margin: 0;
    overflow: hidden;
  }

  .actions {
    display: flex;
    gap: var(--space-300);
  }

  .actions :global(.sable-button) {
    flex: 1;
  }

  @media (width >= 32rem) {
    .actions {
      justify-content: flex-end;
    }

    .actions :global(.sable-button) {
      flex: 0 0 auto;
      min-width: 7rem;
    }
  }
</style>
