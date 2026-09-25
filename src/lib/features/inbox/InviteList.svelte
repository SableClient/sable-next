<script lang="ts">
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
  import LockSimpleIcon from 'phosphor-svelte/lib/LockSimpleIcon';
  import { SvelteSet } from 'svelte/reactivity';

  import { useCoreClient } from '#lib/core/context.js';
  import { formatDate } from '#lib/features/room/timeline-format.js';
  import { i18n } from '#lib/i18n.js';
  import { dismissedInvites } from '#lib/rooms/dismissed-invites.svelte.js';
  import { InviteActions, isDeclining } from '#lib/rooms/invites.svelte.js';
  import { roomLabel, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { DisplayNames } from './display-names.svelte';
  import InboxSectionHeader from './InboxSectionHeader.svelte';
  import { pendingInvites } from './inbox';
  import {
    INVITE_GROUPS,
    type InviteGroup,
    InviteTriage,
    type TriagedInvite,
    triageInvite,
  } from './invite-triage.svelte';

  const GROUP_TITLES = {
    known: 'inbox.invitesKnown',
    strangers: 'inbox.invitesStrangers',
    spam: 'inbox.invitesSpam',
  } as const satisfies Record<InviteGroup, string>;

  const roomList = useRoomList();
  const core = useCoreClient();
  const answers = new InviteActions(core);
  const names = new DisplayNames(core);
  const triage = new InviteTriage(core);
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
  let groups = $derived.by(() => {
    const triaged = invites.map((room) =>
      triageInvite(room, triage.get(room.room_id), (userId) => names.name(userId))
    );
    return INVITE_GROUPS.map((group) => ({
      group,
      members: triaged.filter((invite) => invite.group === group),
    })).filter(({ members }) => members.length > 0);
  });

  let spamOpen = $state(false);
  const revealed = new SvelteSet<string>();
  let blockOpen = $state(false);
  let blocking = $state(false);
  let blockTargets = $state.raw<readonly TriagedInvite[]>([]);
  let blockSenders = $derived([
    ...new Set(blockTargets.flatMap((invite) => (invite.inviter ? [invite.inviter] : []))),
  ]);

  $effect(() => {
    triage.refresh(pending.map((invite) => invite.room_id));
  });

  function setDismissed(roomId: string, next: boolean): void {
    const write = next ? dismissedInvites.dismiss(roomId) : dismissedInvites.restore(roomId);
    write.catch((error: unknown) => {
      console.warn('[sable room] dismissed invites not saved', error);
      toasts.error($i18n.t('errors.actionFailed'));
    });
  }

  function askToBlock(members: readonly TriagedInvite[]): void {
    blockTargets = members;
    blockOpen = true;
  }

  async function block(): Promise<void> {
    blocking = true;
    try {
      await answers.blockAndDecline(
        blockTargets.map((invite) => invite.room),
        blockSenders
      );
    } finally {
      blocking = false;
      blockOpen = false;
    }
  }
</script>

{#if triage.ready && (invites.length > 0 || dismissed.length > 0)}
  <section class="invites" aria-labelledby={headingId}>
    <InboxSectionHeader id={headingId} title={$i18n.t('inbox.invites')} count={invites.length}>
      {#if dismissed.length > 0}
        <Button
          variant="ghost"
          size="small"
          aria-pressed={showDismissed}
          onclick={() => (dismissedOpen = !showDismissed)}
        >
          {showDismissed
            ? $i18n.t('inbox.invitesShowPending')
            : $i18n.t('inbox.invitesShowHidden', { count: dismissed.length })}
        </Button>
      {/if}
    </InboxSectionHeader>

    {#each groups as { group, members } (group)}
      {@const groupId = `${headingId}-${group}`}
      {@const collapsed = group === 'spam' && !spamOpen}
      {@const busy = members.some((invite) => answers.isAnswering(invite.room.room_id))}
      <section class="group" aria-labelledby={groupId}>
        <InboxSectionHeader
          id={groupId}
          level={3}
          title={$i18n.t(GROUP_TITLES[group])}
          count={members.length}
        >
          <div class="group-actions">
            {#if group === 'known' && members.length > 1}
              <Button
                variant="ghost"
                size="small"
                disabled={busy}
                onclick={() => {
                  void answers.acceptAll(members.map((invite) => invite.room));
                }}
              >
                {$i18n.t('inbox.acceptAll')}
              </Button>
            {/if}
            {#if group === 'spam'}
              <Button
                variant="ghost"
                size="small"
                aria-expanded={spamOpen}
                aria-controls={`${groupId}-list`}
                onclick={() => (spamOpen = !spamOpen)}
              >
                {spamOpen ? $i18n.t('inbox.invitesSpamCollapse') : $i18n.t('inbox.invitesSpamShow')}
              </Button>
            {/if}
            {#if group !== 'known' && (group === 'spam' || members.length > 1)}
              <Button
                variant="ghost"
                size="small"
                disabled={busy}
                onclick={() => {
                  answers.declineAll(members.map((invite) => invite.room));
                }}
              >
                {$i18n.t('inbox.declineAll')}
              </Button>
            {/if}
            {#if group === 'spam' && members.some((invite) => invite.inviter)}
              <Button
                variant="ghost"
                size="small"
                disabled={busy}
                onclick={() => {
                  askToBlock(members);
                }}
              >
                {$i18n.t('inbox.blockSenders')}
              </Button>
            {/if}
          </div>
        </InboxSectionHeader>

        {#if group === 'spam'}
          <Alert variant="warning">
            <p>{$i18n.t('inbox.invitesSpamWarning')}</p>
          </Alert>
        {/if}

        {#if !collapsed}
          <ul id={`${groupId}-list`}>
            {#each members as invite (invite.room.room_id)}
              {@render card(invite)}
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  </section>

  <ConfirmDialog
    bind:open={blockOpen}
    title={$i18n.t('inbox.blockSendersTitle', { count: blockSenders.length })}
    description={$i18n.t('inbox.blockSendersBody', { count: blockTargets.length })}
    confirmLabel={$i18n.t('inbox.blockSendersConfirm')}
    busy={blocking}
    onConfirm={() => {
      void block();
    }}
  >
    <ul class="senders">
      {#each blockSenders as sender (sender)}
        <li>
          <span class="sender-name">{names.name(sender)}</span>
          <span class="sender-id">{sender}</span>
        </li>
      {/each}
    </ul>
  </ConfirmDialog>
{/if}

{#snippet card(invite: TriagedInvite)}
  {@const room = invite.room}
  {@const name = roomLabel(room)}
  {@const from = invite.inviter}
  {@const fromName = from ? names.name(from) : null}
  {@const busy = answers.isAnswering(room.room_id)}
  <li class="card">
    <div class="head">
      <Avatar id={room.room_id} src={room.avatar_url} {name} size="large" />
      <div class="identity">
        <p class="name">
          <span class="name-text">{name}</span>
          {#if room.encrypted}
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
          {#if room.is_space}
            <StatusBadge label={$i18n.t('inbox.inviteSpace')} variant="secondary" />
          {/if}
          {#if from && fromName}
            <span title={from}>{$i18n.t('inbox.invitedBy', { name: fromName })}</span>
          {/if}
          {#if room.latest_event?.timestamp}
            <span>{formatDate(room.latest_event.timestamp)}</span>
          {/if}
          {#if room.canonical_alias}
            <span class="alias">{room.canonical_alias}</span>
          {/if}
        </p>
      </div>
    </div>

    {#if room.topic}
      <p class="topic">{room.topic}</p>
    {/if}

    {#if invite.reason}
      {@const label = $i18n.t('inbox.inviteMessageFrom', { name: fromName ?? '' })}
      {#if invite.group === 'spam' && !revealed.has(room.room_id)}
        <Button
          class="reveal"
          variant="ghost"
          size="small"
          onclick={() => {
            revealed.add(room.room_id);
          }}
        >
          {$i18n.t('inbox.inviteMessageShow', { name: fromName ?? '' })}
        </Button>
      {:else}
        <figure class="reason">
          <figcaption>{label}</figcaption>
          <blockquote>{invite.reason}</blockquote>
        </figure>
      {/if}
    {/if}

    <div class="actions">
      <Button
        variant="primary"
        disabled={busy}
        onclick={() => {
          void answers.accept(room);
        }}>{$i18n.t('room.inviteAccept')}</Button
      >
      <Button
        variant="ghost"
        disabled={busy}
        onclick={() => {
          answers.decline(room);
        }}>{$i18n.t('room.inviteDecline')}</Button
      >
      <ActionMenu label={$i18n.t('inbox.inviteOptions', { room: name })}>
        {#snippet trigger({ props })}
          <IconButton
            {...props}
            variant="ghost"
            disabled={busy}
            label={$i18n.t('inbox.inviteOptions', { room: name })}
          >
            <DotsThreeIcon weight="bold" />
          </IconButton>
        {/snippet}
        <ActionMenuItem
          onSelect={() => {
            setDismissed(room.room_id, !showDismissed);
          }}
        >
          {showDismissed ? $i18n.t('inbox.inviteRestore') : $i18n.t('inbox.inviteHide')}
        </ActionMenuItem>
      </ActionMenu>
    </div>
  </li>
{/snippet}

<style>
  .invites {
    container-type: inline-size;
    display: grid;
    gap: var(--space-400);
  }

  .invites > :global(.header) {
    margin-bottom: 0;
  }

  .group {
    display: grid;
    gap: var(--space-300);
  }

  .group > :global(.header) {
    align-items: center;
    margin-bottom: 0;
  }

  .group-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
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

  .reason {
    background: var(--surface-container);
    border-radius: var(--radius-inner);
    display: grid;
    gap: var(--space-100);
    margin: 0;
    padding: var(--space-300);
  }

  .reason figcaption {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }

  .reason blockquote {
    line-height: var(--line-height-body);
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-line;
  }

  .card :global(.reveal) {
    justify-self: start;
  }

  .actions {
    align-items: center;
    display: flex;
    gap: var(--space-300);
  }

  .actions :global(.btn) {
    flex: 1;
  }

  .actions :global(.btn-primary) {
    flex: 2;
  }

  .actions :global(.btn.icon-button) {
    flex: 0 0 auto;
  }

  .senders {
    gap: var(--space-200);
  }

  .senders li {
    display: grid;
    min-width: 0;
  }

  .sender-name {
    font-weight: var(--font-weight-medium);
  }

  .sender-id {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    overflow-wrap: anywhere;
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

    .actions :global(.btn.icon-button) {
      min-width: 0;
    }
  }
</style>
