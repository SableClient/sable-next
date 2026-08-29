<script lang="ts">
  import type { Snippet } from 'svelte';
  import { i18n } from '#lib/i18n.js';
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import PhoneIcon from 'phosphor-svelte/lib/PhoneIcon';
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
  import UsersIcon from 'phosphor-svelte/lib/UsersThreeIcon';
  import type { MemberView } from '#src/generated/MemberView';

  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import { senderColor } from './timeline-format';

  const MAX_FACES = 3;

  interface Props {
    roomName: string;
    roomAvatar: string | null;
    topic?: string | null;
    isVoice: boolean;
    callParticipants: readonly string[];
    members: readonly MemberView[];
    onCall?: (() => void) | null;
    onBack: () => void;
    onMembers: () => void;
    onSearch: () => void;
    onTopic?: (() => void) | null;
    pins?: Snippet;
    menu?: Snippet;
  }

  let {
    roomName,
    roomAvatar,
    topic = null,
    isVoice,
    callParticipants,
    members,
    onCall = null,
    onBack,
    onMembers,
    onSearch,
    onTopic = null,
    pins,
    menu,
  }: Props = $props();

  let inVoice = $derived(
    callParticipants.map((userId) => {
      const member = members.find((entry) => entry.user_id === userId);
      return { userId, name: member?.display_name ?? userId, avatar: member?.avatar_url ?? null };
    })
  );
  let voiceLabel = $derived(
    inVoice.length > 0
      ? $i18n.t('timeline.inVoiceNames', { names: inVoice.map((entry) => entry.name).join(', ') })
      : $i18n.t('nav.voiceRoom')
  );
  let topicShown = $derived(topic !== null && topic.trim() !== '' && onTopic !== null);
</script>

<header class="room-header">
  <IconButton
    class="back-button"
    variant="ghost"
    size="small"
    label={$i18n.t('timeline.back')}
    onclick={onBack}
  >
    <BackIcon />
  </IconButton>
  <Avatar class="room-avatar" src={roomAvatar} name={roomName} size="small" />
  <div class="room-identity" class:with-topic={topicShown}>
    <h1>{roomName}</h1>
    {#if topicShown}
      <button class="room-topic" type="button" onclick={onTopic}>{topic}</button>
    {/if}
  </div>
  {#if isVoice || inVoice.length > 0}
    <span
      class="voice-chip"
      class:live={inVoice.length > 0}
      role="img"
      title={voiceLabel}
      aria-label={voiceLabel}
    >
      <SpeakerHighIcon />
      {#if inVoice.length > 0}
        <span class="voice-faces">
          {#each inVoice.slice(0, MAX_FACES) as participant (participant.userId)}
            <Avatar
              class="voice-face"
              src={participant.avatar}
              name={participant.name}
              color={senderColor(participant.userId)}
            />
          {/each}
        </span>
        <span class="voice-count">{inVoice.length}</span>
      {/if}
    </span>
  {/if}
  <div class="room-actions">
    <IconButton
      class="search-button"
      variant="ghost"
      size="small"
      label={$i18n.t('search.open')}
      onclick={onSearch}
    >
      <MagnifyingGlassIcon />
    </IconButton>
    {@render pins?.()}
    {#if onCall}
      <IconButton
        class="call-button"
        variant="ghost"
        size="small"
        label={inVoice.length > 0 ? $i18n.t('call.join') : $i18n.t('call.start')}
        onclick={onCall}
      >
        <PhoneIcon />
      </IconButton>
    {/if}
    <Button
      class="members-button"
      variant="ghost"
      size="small"
      aria-label={$i18n.t('timeline.members')}
      onclick={onMembers}
    >
      <UsersIcon />
      <span>{$i18n.t('timeline.members')}</span>
    </Button>
    {@render menu?.()}
  </div>
</header>

<style>
  .room-header {
    align-items: center;
    background: var(--sable-bg-container);
    border-bottom: var(--border-width) solid var(--sable-surface-var-container);
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-250);
    min-height: 3.75rem;
    padding: 0 var(--page-gutter);
  }

  .room-identity {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .room-header h1 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .room-identity.with-topic h1 {
    font-size: var(--font-size-body);
  }

  .room-topic {
    background: transparent;
    border: 0;
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    line-height: var(--line-height-small);
    margin: 0;
    overflow: hidden;
    padding: 0;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .room-topic:hover {
    color: var(--sable-bg-on-container);
    text-decoration: underline;
  }

  .room-topic:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .room-actions {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-hairline);
  }

  :global(.sable-avatar.room-avatar) {
    background: var(--sable-primary-main);
    color: var(--sable-primary-on-main);
  }

  .voice-chip {
    align-items: center;
    background: var(--sable-surface-var-container);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-100);
    padding: var(--space-hairline) var(--space-200);
  }

  .voice-chip.live {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  .voice-chip :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .voice-faces {
    display: flex;
  }

  .voice-faces :global(.sable-avatar.voice-face) {
    border: var(--border-width) solid var(--sable-bg-container);
    height: 1.25rem;
    width: 1.25rem;
  }

  .voice-faces :global(.sable-avatar.voice-face:not(:first-child)) {
    margin-left: -0.375rem;
  }

  .voice-count {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
  }

  :global(.back-button),
  :global(.members-button) {
    gap: var(--space-150);
  }

  :global(.back-button) {
    display: inline-flex;
  }

  :global(.sable-avatar.room-avatar),
  :global(.members-button span) {
    display: none;
  }

  :global(.back-button svg),
  :global(.members-button svg),
  :global(.room-menu-button svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  @media (width >= 48rem) {
    :global(.back-button) {
      display: none;
    }

    :global(.sable-avatar.room-avatar) {
      display: inline-flex;
    }

    :global(.members-button span) {
      display: inline;
    }
  }
</style>
