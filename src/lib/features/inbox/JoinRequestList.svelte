<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import type { MemberView, RoomPermissionsView, RoomSummary } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomLabel, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  interface JoinRequest {
    room: RoomSummary;
    member: MemberView;
    permissions: RoomPermissionsView;
  }

  const core = useCoreClient();
  const roomList = useRoomList();
  const answered = new SvelteSet<string>();
  let requests = $state.raw<JoinRequest[]>([]);
  let loading = $state(true);
  let failed = $state(false);
  let actionFailed = $state(false);
  let busy = $state(false);
  let run = 0;
  let pending = $derived(requests.filter((request) => !answered.has(key(request))));

  function key({ room, member }: JoinRequest): string {
    return `${room.room_id}/${member.user_id}/${member.member_ts ?? ''}`;
  }

  $effect(() => {
    void roomList.rooms;
    void load();
    return () => {
      run += 1;
    };
  });

  async function load(): Promise<void> {
    const current = ++run;
    loading = true;
    failed = false;
    const rooms = roomList.rooms.filter(
      (room) =>
        room.state === 'joined' &&
        (room.join_rule === 'knock' || room.join_rule === 'knock_restricted')
    );
    const results = await Promise.allSettled(
      rooms.map(async (room): Promise<JoinRequest[]> => {
        const permissions = await core.commands.roomPermissions(room.room_id);
        if (!permissions.can_invite && !permissions.can_kick) return [];
        const members = await core.commands.roomMembers(room.room_id, ['knock']);
        return members
          .filter((member) => member.membership === 'knock')
          .map((member) => ({ room, member, permissions }));
      })
    );
    if (current !== run) return;
    requests = results
      .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
      .sort((left, right) => (right.member.member_ts ?? 0) - (left.member.member_ts ?? 0));
    failed = results.some((result) => result.status === 'rejected');
    loading = false;
  }

  async function answer(request: JoinRequest, approve: boolean): Promise<void> {
    if (busy) return;
    const { room, member } = request;
    busy = true;
    actionFailed = false;
    try {
      if (approve) await core.commands.inviteUser(room.room_id, member.user_id);
      else
        await core.commands.sendStateEvent(room.room_id, 'm.room.member', member.user_id, {
          membership: 'leave',
        });
      answered.add(key(request));
    } catch (error) {
      console.warn('[sable inbox] answering join request failed', error);
      actionFailed = true;
    } finally {
      busy = false;
    }
  }
</script>

<div class="requests" aria-busy={loading}>
  {#if failed}
    <Alert variant="critical" role="alert">
      <p>{$i18n.t('room.membersRequestsFailed')}</p>
      <Button variant="secondary" size="small" onclick={() => void load()}>
        {$i18n.t('common.tryAgain')}
      </Button>
    </Alert>
  {/if}
  {#if actionFailed}
    <Alert variant="critical" role="alert">{$i18n.t('room.membersRequestActionFailed')}</Alert>
  {/if}
  {#if loading && pending.length === 0}
    <p class="status" role="status"><Spinner small /> {$i18n.t('inbox.checking')}</p>
  {:else if !failed && pending.length === 0}
    <p class="status">{$i18n.t('room.membersNoRequests')}</p>
  {/if}
  <ul>
    {#each pending as request (key(request))}
      {@const member = request.member}
      <li>
        <Avatar id={member.user_id} name={member.display_name ?? member.user_id} size="small" />
        <div class="identity">
          <span class="name">{member.display_name ?? member.user_id}</span>
          <span class="user-id">{member.user_id}</span>
          <span class="room">{roomLabel(request.room)}</span>
        </div>
        <div class="actions">
          {#if request.permissions.can_invite}
            <Button size="small" disabled={busy} onclick={() => void answer(request, true)}>
              {$i18n.t('room.membersApprove')}
            </Button>
          {/if}
          {#if request.permissions.can_kick && member.power_level < request.permissions.own_power_level}
            <Button
              variant="secondary"
              size="small"
              disabled={busy}
              onclick={() => void answer(request, false)}
            >
              {$i18n.t('room.membersDeny')}
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
