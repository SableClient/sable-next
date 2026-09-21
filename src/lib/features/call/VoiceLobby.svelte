<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import type { MemberView } from '#src/generated/protocol';

  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  import CallDevicePreview from './CallDevicePreview.svelte';
  import type { CallMedia } from './call-session.svelte.js';

  interface Props {
    participants: readonly string[];
    members: readonly MemberView[];
    media: CallMedia;
    joining: boolean;
    canJoin: boolean;
    hasPermission: boolean;
    onChange: (media: CallMedia) => void;
    onJoin: () => void;
  }

  let { participants, members, media, joining, canJoin, hasPermission, onChange, onJoin }: Props =
    $props();

  let inVoice = $derived(
    participants.map((userId) => {
      const member = members.find((entry) => entry.user_id === userId);
      return { userId, name: member?.display_name ?? userId, avatar: member?.avatar_url ?? null };
    })
  );
</script>

<section class="lobby" aria-label={$i18n.t('call.title')}>
  <div class="panel">
    {#if inVoice.length > 0}
      <ul class="participants">
        {#each inVoice as participant (participant.userId)}
          <li>
            <Avatar
              src={participant.avatar}
              name={participant.name}
              id={participant.userId}
              size="large"
            />
            <span class="name">{participant.name}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty">{$i18n.t('call.lobbyEmpty')}</p>
    {/if}

    {#if canJoin}
      <CallDevicePreview {media} {joining} {onChange} {onJoin} />
    {:else if !hasPermission}
      <p class="empty">{$i18n.t('call.lobbyNoPermission')}</p>
    {/if}
  </div>
</section>

<style>
  .lobby {
    display: flex;
    flex: 1;
    justify-content: center;
    min-height: 0;
    overflow-y: auto;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-300);
    max-width: 24rem;
    padding: var(--space-400);
    width: 100%;
  }

  .participants {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
    justify-content: center;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .participants li {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    max-width: 6rem;
  }

  .name {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    color: var(--surface-var-on-container);
    margin: 0;
    text-align: center;
  }
</style>
