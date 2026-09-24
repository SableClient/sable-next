<script lang="ts">
  import LockSimpleIcon from 'phosphor-svelte/lib/LockSimpleIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { formatDate } from '#lib/features/room/timeline-format.js';
  import { i18n } from '#lib/i18n.js';
  import { dismissedInvites } from '#lib/rooms/dismissed-invites.svelte.js';
  import { InviteActions, isDeclining } from '#lib/rooms/invites.svelte.js';
  import { roomLabel, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { DisplayNames } from './display-names.svelte';
  import { inviter, pendingInvites } from './inbox';

  const roomList = useRoomList();
  const core = useCoreClient();
  const answers = new InviteActions(core);
  const names = new DisplayNames(core);
  const headingId = $props.id();

  let pending = $derived(
    pendingInvites(roomList.rooms).filter((invite) => !isDeclining(invite.room_id))
  );
  let dismissed = $derived(pending.filter((invite) => dismissedInvites.has(invite.room_id)));
  let dismissedOpen = $state(false);
  let showDismissed = $derived(dismissedOpen && dismissed.length > 0);
  let invites = $derived(
    showDismissed ? dismissed : pending.filter((invite) => !dismissedInvites.has(invite.room_id))
  );

  function setDismissed(roomId: string, next: boolean): void {
    const write = next ? dismissedInvites.dismiss(roomId) : dismissedInvites.restore(roomId);
    write.catch((error: unknown) => {
      console.warn('[sable room] dismissed invites not saved', error);
      toasts.error($i18n.t('errors.actionFailed'));
    });
  }
</script>

{#if invites.length > 0 || dismissed.length > 0}
  <section aria-labelledby={headingId}>
    <div class="section-head">
      <h2 id={headingId}>
        {$i18n.t('inbox.invites')}
        <span class="count" aria-hidden="true">{invites.length}</span>
      </h2>
      {#if dismissed.length > 0}
        <Button
          class="dismissed-toggle"
          variant="ghost"
          size="small"
          aria-pressed={showDismissed}
          onclick={() => (dismissedOpen = !showDismissed)}
        >
          {showDismissed
            ? $i18n.t('inbox.invitesShowPending')
            : $i18n.t('inbox.invitesShowDismissed', { count: dismissed.length })}
        </Button>
      {/if}
    </div>
    <ul>
      {#each invites as invite (invite.room_id)}
        {@const name = roomLabel(invite)}
        {@const from = inviter(invite)}
        {@const busy = answers.isAnswering(invite.room_id)}
        <li class="card">
          <div class="head">
            <Avatar id={invite.room_id} src={invite.avatar_url} {name} size="large" />
            <div class="identity">
              <p class="name">
                <span class="name-text">{name}</span>
                {#if invite.encrypted}
                  <span
                    class="lock"
                    role="img"
                    aria-label={$i18n.t('inbox.inviteEncrypted')}
                    title={$i18n.t('inbox.inviteEncrypted')}
                  >
                    <LockSimpleIcon aria-hidden="true" />
                  </span>
                {/if}
              </p>
              <p class="meta">
                {#if invite.is_space}
                  <StatusBadge label={$i18n.t('inbox.inviteSpace')} variant="secondary" />
                {/if}
                {#if from}
                  <span title={from}>{$i18n.t('inbox.invitedBy', { name: names.name(from) })}</span>
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
              variant="primary"
              disabled={busy}
              onclick={() => {
                void answers.accept(invite);
              }}>{$i18n.t('room.inviteAccept')}</Button
            >
            <Button
              variant="ghost"
              disabled={busy}
              onclick={() => {
                answers.decline(invite);
              }}>{$i18n.t('room.inviteDecline')}</Button
            >
            <Button
              variant="ghost"
              disabled={busy}
              onclick={() => {
                setDismissed(invite.room_id, !showDismissed);
              }}
              >{showDismissed
                ? $i18n.t('inbox.inviteRestore')
                : $i18n.t('inbox.inviteDismiss')}</Button
            >
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  section {
    container-type: inline-size;
  }

  .section-head {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    justify-content: space-between;
    margin: 0 0 var(--space-300);
  }

  h2 {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-500);
    gap: var(--space-200);
    letter-spacing: 0.08em;
    margin: 0;
    text-transform: uppercase;
  }

  .count {
    background: var(--primary-main);
    border-radius: var(--radius-pill);
    color: var(--primary-on-main);
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
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
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
    color: var(--success-main);
    display: flex;
    flex: 0 0 auto;
  }

  .lock :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .meta {
    align-items: center;
    color: var(--surface-var-on-container);
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
    color: var(--surface-var-on-container);
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

  .actions :global(.btn) {
    flex: 1;
  }

  .actions :global(.btn-primary) {
    flex: 2;
  }

  @container (width >= 32rem) {
    .actions {
      flex-direction: row-reverse;
      justify-content: flex-start;
    }

    .actions :global(.btn),
    .actions :global(.btn-primary) {
      flex: 0 0 auto;
      min-width: 7rem;
    }
  }
</style>
