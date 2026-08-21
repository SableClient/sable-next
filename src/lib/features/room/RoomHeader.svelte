<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import UsersIcon from 'phosphor-svelte/lib/UsersThreeIcon';

  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  interface Props {
    roomName: string;
    roomAvatar: string | null;
    onBack: () => void;
    onMembers: () => void;
    onSettings: () => void;
    initials: (name: string) => string;
  }

  let { roomName, roomAvatar, onBack, onMembers, onSettings, initials }: Props = $props();
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
  <Avatar class="room-avatar" src={roomAvatar} initials={initials(roomName)} size="small" />
  <h1>{roomName}</h1>
  <!-- Narrow viewports hide the label, leaving the icon as the only content. -->
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
  <IconButton
    class="settings-button"
    variant="ghost"
    size="small"
    label={$i18n.t('room.settingsOpen')}
    onclick={onSettings}
  >
    <GearIcon />
  </IconButton>
</header>

<style>
  .room-header {
    align-items: center;
    background: var(--sable-bg-container);
    border-bottom: var(--border-width) solid var(--sable-surface-var-container);
    display: flex;
    flex: 0 0 auto;
    gap: 0.625rem;
    min-height: 3.75rem;
    padding: 0 var(--page-gutter);
  }

  .room-header h1 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.sable-avatar.room-avatar) {
    background: var(--sable-primary-main);
    color: var(--sable-primary-on-main);
  }

  :global(.back-button),
  :global(.members-button) {
    gap: 0.375rem;
  }

  :global(.back-button) {
    display: inline-flex;
  }

  :global(.sable-avatar.room-avatar),
  :global(.members-button span) {
    display: none;
  }

  :global(.members-button) {
    margin-left: auto;
  }

  :global(.back-button svg),
  :global(.members-button svg),
  :global(.settings-button svg) {
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
