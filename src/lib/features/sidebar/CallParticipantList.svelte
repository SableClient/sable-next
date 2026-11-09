<script lang="ts">
  import type { RoomListItemView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import SpeakerSlashIcon from 'phosphor-svelte/lib/SpeakerSlashIcon';
  import VideoCameraIcon from 'phosphor-svelte/lib/VideoCameraIcon';
  import { whenVisible } from '#lib/ui/when-visible.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import type { CallVoiceState } from '#lib/features/call/call-session.svelte.js';
  import { byName, numberedName, participantKeys } from '#lib/features/call/participant-keys.js';
  import type { PeerProfiles } from './peer-profiles.svelte.js';

  interface Props {
    room: RoomListItemView;
    collapsed: boolean;
    closed: boolean;
    voiceStates?: ReadonlyMap<string, CallVoiceState>;
    profiles: PeerProfiles;
    onVolume: (event: MouseEvent, userId: string, name: string) => void;
    onParticipant: (event: MouseEvent, userId: string) => void;
  }

  let { room, collapsed, closed, voiceStates, profiles, onVolume, onParticipant }: Props = $props();

  const core = useCoreClient();
  let live = $derived(room.call_participants.length);
  let participants = $derived(
    byName(room.call_participants, (userId) => profiles.get(userId)?.display_name)
  );
  let rowKeys = $derived(participantKeys(participants));
</script>

<ul
  class={['call-participant-list', { collapsed, 'closed-row': closed }]}
  aria-label={i18n.t('nav.voiceLive', { count: live })}
>
  {#each participants as userId, index (rowKeys[index])}
    {@const profile = profiles.get(userId)}
    {@const voice = voiceStates?.get(rowKeys[index] ?? userId)}
    {@const sharing = voice ? voice.screen : room.screen_sharers.includes(userId)}
    {@const name = profile?.display_name ?? userId}
    {@const displayName = numberedName(name, rowKeys[index] ?? userId)}
    <li
      class={{ speaking: voice?.speaking && !voice.muted }}
      oncontextmenu={voice && userId !== core.session?.user_id
        ? (event) => onVolume(event, userId, displayName)
        : undefined}
      {@attach whenVisible(() => {
        profiles.request(userId);
      })}
    >
      <button
        type="button"
        class="call-participant"
        onclick={(event) => {
          onParticipant(event, userId);
        }}
      >
        <Avatar
          src={profile?.avatar_url ?? null}
          {name}
          id={userId}
          size="small"
          alt={collapsed ? name : undefined}
        />
        {#if !collapsed}
          <span>{displayName}</span>
          {#if sharing || (voice && (voice.muted || voice.deafened || voice.camera))}
            <span class="voice-badges">
              {#if sharing}
                <span class="voice-stream">{i18n.t('call.live')}</span>
              {/if}
              {#if voice?.camera}
                {@const cameraLabel = i18n.t('call.cameraOnLabel')}
                <Tooltip label={cameraLabel}>
                  {#snippet trigger({ props })}
                    <span {...props}>
                      <VideoCameraIcon aria-hidden="true" weight="fill" />
                      <span class="screen-reader-only">{cameraLabel}</span>
                    </span>
                  {/snippet}
                </Tooltip>
              {/if}
              {#if voice?.deafened}
                {@const deafenLabel = i18n.t('call.deafened')}
                <Tooltip label={deafenLabel}>
                  {#snippet trigger({ props })}
                    <span {...props} class="voice-off">
                      <SpeakerSlashIcon aria-hidden="true" weight="fill" />
                      <span class="screen-reader-only">{deafenLabel}</span>
                    </span>
                  {/snippet}
                </Tooltip>
              {:else if voice?.muted}
                {@const muteLabel = i18n.t('call.muted')}
                <Tooltip label={muteLabel}>
                  {#snippet trigger({ props })}
                    <span {...props} class="voice-off">
                      <MicrophoneSlashIcon aria-hidden="true" weight="fill" />
                      <span class="screen-reader-only">{muteLabel}</span>
                    </span>
                  {/snippet}
                </Tooltip>
              {/if}
            </span>
          {/if}
        {/if}
      </button>
    </li>
  {/each}
</ul>

<style>
  .call-participant-list.closed-row {
    display: none;
  }

  .call-participant-list {
    display: grid;
    gap: var(--space-050);
    list-style: none;
    margin: 0;
    padding: 0 0 0 calc(var(--space-400) + var(--room-depth, 0) * var(--space-400));
  }

  .call-participant-list li {
    min-width: 0;
  }

  .call-participant {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: var(--space-200);
    min-width: 0;
    padding: var(--space-100) var(--space-200);
    text-align: start;
    width: 100%;
  }

  .call-participant:hover {
    background: var(--bg-container-hover);
  }

  .call-participant-list :global(.avatar-root) {
    --avatar-size: var(--avatar-size-200);

    flex: none;
    transition: box-shadow var(--motion-normal) var(--motion-easing-emphasized);
  }

  .speaking .call-participant {
    color: var(--bg-on-container);
  }

  .call-participant-list li.speaking :global(.avatar-root) {
    box-shadow:
      0 0 0 var(--border-width-300) var(--bg-container),
      0 0 0 calc(var(--border-width-300) + var(--border-width-500)) var(--success-main);
  }

  .voice-badges {
    align-items: center;
    color: var(--surface-var-on-container);
    display: inline-flex;
    flex: none;
    gap: var(--space-100);
    margin-inline-start: auto;
  }

  .voice-badges > span {
    display: inline-flex;
  }

  .voice-badges :global(svg) {
    height: var(--size-x50);
    width: var(--size-x50);
  }

  .voice-off {
    color: var(--crit-main);
  }

  .voice-stream {
    background: var(--crit-main);
    border-radius: var(--radii-300);
    color: var(--crit-on-main);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.04em;
    padding: 0 var(--space-100);
    text-transform: uppercase;
  }

  .call-participant-list li span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .call-participant-list.collapsed {
    justify-items: center;
    padding: 0;
  }

  .call-participant-list.collapsed .call-participant {
    padding: var(--space-050) 0;
  }
</style>
