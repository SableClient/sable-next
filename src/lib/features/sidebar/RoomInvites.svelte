<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import type { RoomSummary } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { inviter, senderName } from '#lib/features/inbox/inbox.js';
  import { i18n } from '#lib/i18n.js';
  import { InviteActions } from '#lib/rooms/invites.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  interface Props {
    invites: readonly RoomSummary[];
    collapsed?: boolean;
  }

  let { invites, collapsed = false }: Props = $props();
  const answers = new InviteActions(useCoreClient());
  const headingId = $props.id();
</script>

{#if invites.length > 0 && !collapsed}
  <section class="invites" aria-labelledby={headingId}>
    <h3 id={headingId}>
      {$i18n.t('room.invitesTitle')}
      <span class="count">{invites.length}</span>
    </h3>
    <ul>
      {#each invites as invite (invite.room_id)}
        {@const name = invite.name ?? invite.room_id}
        {@const from = inviter(invite)}
        {@const busy = answers.isAnswering(invite.room_id)}
        <li>
          <Avatar class="invite-icon" id={invite.room_id} src={invite.avatar_url} {name} />
          <span class="invite-text">
            <span class="invite-name" title={name}>{name}</span>
            {#if from}
              <span class="invite-from" title={from}>
                {$i18n.t('inbox.invitedBy', { name: senderName(from) })}
              </span>
            {/if}
          </span>
          <div class="invite-actions">
            <IconButton
              variant="ghost"
              size="medium"
              disabled={busy}
              label={$i18n.t('room.inviteAcceptLabel', { room: name })}
              onclick={() => {
                void answers.accept(invite);
              }}
            >
              <CheckIcon />
            </IconButton>
            <IconButton
              variant="ghost"
              size="medium"
              disabled={busy}
              label={$i18n.t('room.inviteDeclineLabel', { room: name })}
              onclick={() => {
                answers.decline(invite);
              }}
            >
              <XIcon />
            </IconButton>
          </div>
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
    align-items: center;
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-500);
    gap: var(--space-200);
    margin: 0;
    padding: 0 var(--space-200);
    text-transform: uppercase;
  }

  .count {
    font-variant-numeric: tabular-nums;
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
    background: var(--bg-container-hover);
  }

  .invite-actions {
    display: flex;
    flex: none;
    gap: var(--space-200);
  }

  :global(.avatar-root.invite-icon) {
    --avatar-size: 1.75rem;

    font-size: var(--font-size-small);
  }

  .invite-text {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .invite-name,
  .invite-from {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .invite-from {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }
</style>
