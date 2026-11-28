<script lang="ts">
  import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import {
    canApprove,
    canDeny,
    joinRequestKey,
    useJoinRequests,
  } from '#lib/rooms/join-requests.svelte.js';
  import { memberName } from '#lib/rooms/member-listing.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  const SHOWN = 3;

  interface Props {
    roomId: string;
    onAll: () => void;
  }

  let { roomId, onAll }: Props = $props();
  const requests = useJoinRequests(useCoreClient(), useRoomList());
  const headingId = $props.id();
  let unseen = $derived(requests.unseen(roomId));
</script>

{#if unseen.length > 0}
  <section class="join-requests" aria-labelledby={headingId}>
    <h3 id={headingId}>
      <span class="count">{unseen.length}</span>
      {i18n.t('room.joinRequestsTitle')}
    </h3>
    <ul>
      {#each unseen.slice(0, SHOWN) as request (joinRequestKey(request))}
        {@const name = memberName(request.member)}
        <li>
          <Avatar
            class="request-avatar"
            id={request.member.user_id}
            src={request.member.avatar_url}
            {name}
          />
          <span class="name">{name}</span>
          {#if canApprove(request)}
            <IconButton
              variant="ghost"
              size="small"
              disabled={requests.busy}
              label={i18n.t('room.joinRequestApproveLabel', { name })}
              onclick={() => void requests.answer(request, true)}
            >
              <CheckIcon />
            </IconButton>
          {/if}
          {#if canDeny(request)}
            <IconButton
              variant="ghost"
              size="small"
              disabled={requests.busy}
              label={i18n.t('room.joinRequestDenyLabel', { name })}
              onclick={() => void requests.answer(request, false)}
            >
              <XIcon />
            </IconButton>
          {/if}
        </li>
      {/each}
    </ul>
    {#if requests.actionFailed}
      <p class="error" role="alert">{i18n.t('room.membersRequestActionFailed')}</p>
    {/if}
    <div class="footer">
      <Button variant="ghost" size="small" onclick={onAll}>
        {i18n.t('room.joinRequestsAll')}
        <ArrowRightIcon class="mirror-rtl" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="small" onclick={() => requests.dismiss(roomId)}>
        <XIcon aria-hidden="true" />
        {i18n.t('common.dismiss')}
      </Button>
    </div>
  </section>
{/if}

<style>
  .join-requests {
    background: var(--surface-var-container);
    border-radius: var(--radius);
    padding: var(--space-200);
  }

  h3 {
    align-items: center;
    display: flex;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-500);
    gap: var(--space-200);
    margin: 0;
    padding: 0 var(--space-200);
  }

  .count {
    align-items: center;
    background: var(--success-main);
    border-radius: var(--radii-pill);
    color: var(--success-on-main);
    display: inline-flex;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    height: var(--size-x50);
    justify-content: center;
    min-width: var(--size-x50);
    padding: 0 var(--space-100);
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
    display: flex;
    gap: var(--space-200);
    min-height: var(--control-height-medium);
    padding: 0 var(--space-100) 0 var(--space-200);
  }

  :global(.avatar-root.request-avatar) {
    --avatar-size: 1.5rem;

    font-size: var(--font-size-small);
  }

  .name {
    flex: 1;
    font-size: var(--font-size-label);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error {
    color: var(--crit-main);
    font-size: var(--font-size-small);
    margin: var(--space-100) var(--space-200) 0;
  }

  .footer {
    display: flex;
    justify-content: space-between;
    margin-top: var(--space-100);
  }
</style>
