<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { whenVisible } from '#lib/ui/when-visible.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import { byName, participantKeys } from '#lib/features/call/participant-keys.js';

  import type { PeerProfiles } from './peer-profiles.svelte.js';

  const MAX_VOICE_FACES = 3;

  interface Props {
    participants: readonly string[];
    showFaces: boolean;
    showCount: boolean;
    profiles: PeerProfiles;
  }

  let { participants, showFaces, showCount, profiles }: Props = $props();
</script>

<span
  class="voice-live"
  role="img"
  aria-label={i18n.t('nav.voiceLive', { count: participants.length })}
>
  {#if showFaces}
    {@const faces = byName(participants, (userId) => profiles.get(userId)?.display_name).slice(
      0,
      MAX_VOICE_FACES
    )}
    {@const faceKeys = participantKeys(faces)}
    <span
      class="voice-faces"
      {@attach whenVisible(() => {
        for (const userId of faces) profiles.request(userId);
      })}
    >
      {#each faces as userId, index (faceKeys[index])}
        {@const profile = profiles.get(userId)}
        <Avatar
          class="voice-face"
          src={profile?.avatar_url ?? null}
          name={profile?.display_name ?? userId}
          id={userId}
        />
      {/each}
    </span>
  {/if}
  {#if showCount}
    <StatusBadge label={String(participants.length)} variant="primary" />
  {/if}
</span>

<style>
  .voice-live {
    align-items: center;
    display: flex;
    flex: none;
    gap: var(--space-100);
  }

  .voice-faces {
    display: flex;
  }

  .voice-faces :global(.avatar-root.voice-face) {
    --avatar-size: 1.25rem;

    border: var(--border-width) solid var(--bg-container);
  }

  .voice-faces :global(.avatar-root.voice-face:not(:first-child)) {
    margin-inline-start: calc(-1 * var(--space-150));
  }
</style>
