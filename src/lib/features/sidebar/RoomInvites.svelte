<script lang="ts">
  import { mediaPreviewSettings } from '#lib/settings/media-previews.svelte.js';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import type { RoomListItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { DisplayNames } from '#lib/features/inbox/display-names.svelte.js';
  import { inviter } from '#lib/features/inbox/inbox.js';
  import { i18n } from '#lib/i18n.js';
  import { InviteActions } from '#lib/rooms/invites.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  interface Props {
    invites: readonly RoomListItemView[];
    collapsed?: boolean;
  }

  let { invites, collapsed = false }: Props = $props();
  const core = useCoreClient();
  const answers = new InviteActions(core);
  const names = new DisplayNames(core);
  $effect(() => core.onProfileChanged(names.forget));
  const headingId = $props.id();
</script>

{#if invites.length > 0 && !collapsed}
  <section class="invites" aria-labelledby={headingId}>
    <h3 id={headingId}>
      {i18n.t('room.invitesTitle')}
      <span class="count">{invites.length}</span>
    </h3>
    <ul>
      {#each invites as invite (invite.room_id)}
        {@const name = invite.name ?? invite.room_id}
        {@const from = inviter(invite)}
        {@const busy = answers.isAnswering(invite.room_id)}
        <li>
          <Avatar
            class="invite-icon"
            id={invite.room_id}
            src={mediaPreviewSettings.inviteAvatars === 'on' ? invite.avatar_url : null}
            {name}
          />
          <span class="invite-text">
            <Tooltip label={name}>
              {#snippet trigger({ props })}
                <span {...props} class="invite-name">{name}</span>
              {/snippet}
            </Tooltip>
            {#if from}
              {@const invitedBy = i18n.t('inbox.invitedBy', { name: names.name(from) })}
              <Tooltip label={from}>
                {#snippet trigger({ props })}
                  <span {...props} class="invite-from">{invitedBy}</span>
                {/snippet}
              </Tooltip>
            {/if}
          </span>
          <div class="invite-actions">
            <Tooltip label={i18n.t('room.inviteAcceptLabel', { room: name })}>
              {#snippet trigger({ props })}
                <IconButton
                  {...props}
                  variant="ghost"
                  size="small"
                  disabled={busy}
                  label={i18n.t('room.inviteAcceptLabel', { room: name })}
                  onclick={() => {
                    void answers.accept(invite);
                  }}
                >
                  <CheckIcon />
                </IconButton>
              {/snippet}
            </Tooltip>
            <Tooltip label={i18n.t('room.inviteDeclineLabel', { room: name })}>
              {#snippet trigger({ props })}
                <IconButton
                  {...props}
                  variant="ghost"
                  size="small"
                  disabled={busy}
                  label={i18n.t('room.inviteDeclineLabel', { room: name })}
                  onclick={() => {
                    answers.decline(invite);
                  }}
                >
                  <XIcon />
                </IconButton>
              {/snippet}
            </Tooltip>
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .invites {
    background: var(--surface-var-container);
    border-radius: var(--radius-inner);
    margin-bottom: var(--space-200);
    padding: var(--space-200);
  }

  h3 {
    align-items: center;
    color: var(--bg-on-container);
    display: flex;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-500);
    gap: var(--space-200);
    margin: 0;
    opacity: var(--opacity-p300);
    padding: 0 var(--space-200);
  }

  .count {
    align-items: center;
    background: var(--success-main);
    border-radius: var(--radii-pill);
    box-sizing: border-box;
    color: var(--success-on-main);
    display: inline-flex;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    font-weight: var(--font-weight-medium);
    height: var(--size-x50);
    justify-content: center;
    line-height: var(--size-x50);
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

  .invite-actions :global(.icon-button:hover) {
    background: var(--surface-container-hover);
    color: var(--surface-on-container);
  }

  :global(.avatar-root.invite-icon) {
    --avatar-size: 1.5rem;

    font-size: var(--font-size-small);
  }

  .invite-text {
    display: flex;
    flex: 1;
    flex-flow: column nowrap;
    gap: var(--space-100);
    justify-content: center;
    min-width: 0;
  }

  .invite-name,
  .invite-from {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .invite-name {
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-500);
    line-height: 1;
  }

  .invite-from {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: 1;
  }
</style>
