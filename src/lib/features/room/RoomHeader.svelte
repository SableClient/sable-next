<script lang="ts">
  import type { Snippet } from 'svelte';
  import { i18n } from '#lib/i18n.js';
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon';
  import PhoneIcon from 'phosphor-svelte/lib/PhoneIcon';
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
  import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';
  import type { MemberView } from '#src/generated/protocol';

  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';

  import { participantKeys } from '#lib/features/call/participant-keys.js';

  import { memberIdentity } from './members.js';

  const MAX_FACES = 3;

  interface Props {
    roomId: string;
    roomName: string;
    roomAvatar: string | null;
    topic?: string | null;
    isVoice: boolean;
    callParticipants: readonly string[];
    members: readonly MemberView[];
    membersOpen?: boolean;
    onCall?: (() => void) | null;
    onToggleChat?: (() => void) | null;
    chatOpen?: boolean;
    chatBeside?: boolean;
    onBack: () => void;
    onMembers: () => void;
    onSearch: () => void;
    onTopic?: (() => void) | null;
    pins?: Snippet;
    actions?: Snippet;
    menu?: Snippet;
  }

  let {
    roomId,
    roomName,
    roomAvatar,
    topic = null,
    isVoice,
    callParticipants,
    members,
    membersOpen = false,
    onCall = null,
    onToggleChat = null,
    chatOpen = false,
    chatBeside = false,
    onBack,
    onMembers,
    onSearch,
    onTopic = null,
    pins,
    actions,
    menu,
  }: Props = $props();

  let inVoice = $derived(callParticipants.map((userId) => memberIdentity(members, userId)));
  let inVoiceKeys = $derived(participantKeys(inVoice.map((entry) => entry.userId)));
  let voiceLabel = $derived(
    inVoice.length > 0
      ? $i18n.t('timeline.inVoiceNames', {
          names: [...new Set(inVoice.map((entry) => entry.name))].join(', '),
        })
      : $i18n.t('nav.voiceRoom')
  );
  let topicShown = $derived(topic !== null && topic.trim() !== '' && onTopic !== null);
</script>

<PanelHeader class="room-header">
  {#snippet prefix()}
    <PanelHeaderButton class="back-button" label={$i18n.t('timeline.back')} onclick={onBack}>
      <BackIcon />
    </PanelHeaderButton>

    <Avatar class="room-avatar" id={roomId} src={roomAvatar} name={roomName} size="small" />
  {/snippet}

  {#snippet main()}
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
            {#each inVoice.slice(0, MAX_FACES) as participant, index (inVoiceKeys[index])}
              <Avatar
                class="voice-face"
                src={participant.avatar}
                name={participant.name}
                id={participant.userId}
              />
            {/each}
          </span>
          <span class="voice-count">{inVoice.length}</span>
        {/if}
      </span>
    {/if}
  {/snippet}

  {#snippet suffix()}
    <PanelHeaderButton class="search-button" label={$i18n.t('search.open')} onclick={onSearch}>
      <MagnifyingGlassIcon />
    </PanelHeaderButton>
    {@render pins?.()}
    {#if onToggleChat}
      <PanelHeaderButton
        class="chat-toggle"
        label={chatBeside
          ? chatOpen
            ? $i18n.t('call.hideChat')
            : $i18n.t('call.showChat')
          : chatOpen
            ? $i18n.t('call.showCall')
            : $i18n.t('call.showChat')}
        aria-pressed={chatOpen}
        onclick={onToggleChat}
      >
        {#if chatOpen && !chatBeside}
          <PhoneIcon />
        {:else}
          <ChatCircleIcon weight={chatOpen ? 'fill' : 'regular'} />
        {/if}
      </PanelHeaderButton>
    {/if}
    {#if onCall}
      <PanelHeaderButton
        class="call-button"
        label={inVoice.length > 0 ? $i18n.t('call.join') : $i18n.t('call.start')}
        onclick={onCall}
      >
        <PhoneIcon />
      </PanelHeaderButton>
    {/if}
    {@render actions?.()}
    <PanelHeaderButton
      class="members-button selection-open"
      label={$i18n.t('timeline.members')}
      aria-pressed={membersOpen}
      data-state={membersOpen ? 'open' : 'closed'}
      onclick={onMembers}
    >
      <UserCircleIcon weight={membersOpen ? 'fill' : 'regular'} />
    </PanelHeaderButton>
    {@render menu?.()}
  {/snippet}
</PanelHeader>

<style>
  .room-identity {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  h1 {
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
    color: var(--surface-var-on-container);
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
    color: var(--surface-on-container);
    text-decoration: underline;
  }

  .room-topic:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  :global(.avatar-root.room-avatar) {
    display: none;
  }

  .voice-chip {
    align-items: center;
    background: var(--surface-var-container);
    border-radius: var(--radius-pill);
    color: var(--surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-100);
    padding: var(--space-050) var(--space-200);
  }

  .voice-chip.live {
    background: var(--primary-container);
    color: var(--primary-on-container);
  }

  .voice-chip :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .voice-faces {
    display: flex;
  }

  .voice-faces :global(.avatar-root.voice-face) {
    --avatar-size: 1.25rem;

    border: var(--border-width) solid var(--surface-container);
  }

  .voice-faces :global(.avatar-root.voice-face:not(:first-child)) {
    margin-left: calc(-1 * var(--space-150));
  }

  .voice-count {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
  }

  :global(.back-button) {
    display: inline-flex;
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

    :global(.avatar-root.room-avatar) {
      display: inline-flex;
    }
  }
</style>
