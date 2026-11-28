<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { memberName } from '#lib/rooms/member-listing.js';
  import {
    canApprove,
    canDeny,
    joinRequestKey,
    useJoinRequests,
  } from '#lib/rooms/join-requests.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  const requests = useJoinRequests(useCoreClient(), useRoomList());
</script>

<div class="requests" aria-busy={requests.loading}>
  {#if requests.failed}
    <Alert variant="critical" role="alert">
      <p>{i18n.t('room.membersRequestsFailed')}</p>
      <Button variant="secondary" size="small" onclick={() => void requests.load()}>
        {i18n.t('common.tryAgain')}
      </Button>
    </Alert>
  {/if}
  {#if requests.actionFailed}
    <Alert variant="critical" role="alert">{i18n.t('room.membersRequestActionFailed')}</Alert>
  {/if}
  {#if requests.loading && requests.pending.length === 0}
    <p class="status" role="status"><Spinner small /> {i18n.t('inbox.checking')}</p>
  {:else if !requests.failed && requests.pending.length === 0}
    <p class="status">{i18n.t('room.membersNoRequests')}</p>
  {/if}
  <ul>
    {#each requests.pending as request (joinRequestKey(request))}
      {@const member = request.member}
      <li>
        <Avatar id={member.user_id} name={memberName(member)} size="small" />
        <div class="identity">
          <span class="name">{memberName(member)}</span>
          <span class="user-id">{member.user_id}</span>
          <span class="room">{request.room.display_name}</span>
        </div>
        <div class="actions">
          {#if canApprove(request)}
            <Button
              size="small"
              disabled={requests.busy}
              onclick={() => void requests.answer(request, true)}
            >
              {i18n.t('room.membersApprove')}
            </Button>
          {/if}
          {#if canDeny(request)}
            <Button
              variant="secondary"
              size="small"
              disabled={requests.busy}
              onclick={() => void requests.answer(request, false)}
            >
              {i18n.t('room.membersDeny')}
            </Button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
</div>

<style>
  .requests {
    display: grid;
    gap: var(--space-300);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
    padding-block: var(--space-400);
  }

  li + li {
    border-top: var(--border-width) solid var(--surface-container-line);
  }

  .identity {
    display: grid;
    flex: 1 1 12rem;
    gap: var(--space-050);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .name {
    font-weight: var(--font-weight-medium);
  }

  .user-id,
  .room {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .status {
    color: var(--surface-var-on-container);
    margin: 0;
    text-align: center;
  }
</style>
